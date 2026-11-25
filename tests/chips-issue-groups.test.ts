import { describe, it, expect } from 'vitest';
import {
  MAX_CHIPS_PER_GROUP,
  findDuplicateNumber,
  holderUpdatesForBlock,
  legacyChipBodyToInput,
} from '@/lib/chips/issueGroups';
import type { IssueChipGroup } from '@/lib/types/chips';

// The multi-person issue window sends holder GROUPS (one per person+type; the
// client splits a mixed-type block into per-type groups). These helpers are
// the shared authority for cross-group duplicate detection and the legacy
// flat-body adapter. Since 21/11/2026 there is no limit of active chips per
// apartment and no override reason.

function group(partial: Partial<IssueChipGroup>): IssueChipGroup {
  return {
    resident_role: 'owner',
    chip_type: 'physical',
    numbers: [],
    ...partial,
  };
}

describe('no quantity limit in the issue window (21/11/2026)', () => {
  it('the soft limit of 4 active chips per apartment is gone', async () => {
    const mod = await import('@/lib/chips/issueGroups');
    expect(mod).not.toHaveProperty('ACTIVE_CHIPS_SOFT_LIMIT');
    expect(mod).not.toHaveProperty('exceedsSoftLimit');
  });

  it('one block may carry many new numbers in one save (only a request bound remains)', () => {
    expect(MAX_CHIPS_PER_GROUP).toBeGreaterThanOrEqual(50);
  });
});

describe('findDuplicateNumber — within and across groups', () => {
  it('catches a repeat across two groups and points at the second', () => {
    const dup = findDuplicateNumber([
      group({ numbers: ['A-1'] }),
      group({ numbers: ['A-2', 'A-1'] }),
    ]);
    expect(dup).toEqual({ number: 'A-1', group_index: 1 });
  });

  it('catches a repeat inside one group (after trim)', () => {
    const dup = findDuplicateNumber([group({ numbers: ['A-1', ' A-1 '] })]);
    expect(dup).toEqual({ number: 'A-1', group_index: 0 });
  });

  it('null when all numbers are distinct', () => {
    expect(
      findDuplicateNumber([group({ numbers: ['A-1'] }), group({ numbers: ['A-2'] })]),
    ).toBeNull();
  });
});

describe('legacyChipBodyToInput — the pre-groups flat body adapter', () => {
  it('maps every field; fee and notes stay window-global', () => {
    const input = legacyChipBodyToInput({
      contact_id: 'c-1',
      chip_type: 'app',
      chip_numbers: ['A-1', 'A-2'],
      resident_role: 'tenant',
      holder_name: 'שרה',
      holder_phone: '0501234567',
      app_platform: 'ios',
      app_invite_status: 'pending',
      app_expires_at: '2027-01-01',
      issuance_fee: 50,
      fee_charged: true,
      notes: 'הערה',
    });

    expect(input.contact_id).toBe('c-1');
    expect(input.groups).toHaveLength(1);
    expect(input.groups[0]).toMatchObject({
      resident_role: 'tenant',
      holder_name: 'שרה',
      holder_phone: '0501234567',
      chip_type: 'app',
      numbers: ['A-1', 'A-2'],
      app_platform: 'ios',
      app_invite_status: 'pending',
      app_expires_at: '2027-01-01',
    });
    expect(input.issuance_fee).toBe(50);
    expect(input.fee_charged).toBe(true);
    expect(input.notes).toBe('הערה');
    expect(input).not.toHaveProperty('limit_override_reason');
  });
});

describe('holderUpdatesForBlock — only what the user actually changed', () => {
  const ids = ['c1', 'c2'];
  const orig = { name: 'רונן', phone: '0525460546', role: 'tenant' as const };

  it('untouched block → no updates (even if a chip snapshot drifted)', () => {
    expect(holderUpdatesForBlock(ids, { ...orig }, orig)).toEqual([]);
  });

  it('emits one entry per saved chip carrying ONLY the changed fields', () => {
    const out = holderUpdatesForBlock(ids, { ...orig, phone: '0501234567' }, orig);
    expect(out).toEqual([
      { id: 'c1', holder_phone: '0501234567' },
      { id: 'c2', holder_phone: '0501234567' },
    ]);
  });

  it('role + name change together', () => {
    const out = holderUpdatesForBlock(['c1'], { name: 'דנה', phone: orig.phone, role: 'other' }, orig);
    expect(out).toEqual([{ id: 'c1', holder_name: 'דנה', resident_role: 'other' }]);
  });

  it('clearing a field sends null', () => {
    expect(holderUpdatesForBlock(['c1'], { ...orig, phone: null }, orig)).toEqual([
      { id: 'c1', holder_phone: null },
    ]);
  });

  it('a block with no saved chips, no seed, or no role never emits', () => {
    expect(holderUpdatesForBlock([], { ...orig, name: 'x' }, orig)).toEqual([]);
    expect(holderUpdatesForBlock(ids, { ...orig, name: 'x' }, null)).toEqual([]);
    expect(holderUpdatesForBlock(ids, { ...orig, role: null }, orig)).toEqual([]);
  });

  // 25/11/2026 — the block's email, a renter's lease and its end date.
  const lease = { key: '11111111-1111-4111-8111-111111111111.pdf', name: 'חוזה.pdf', mime: 'application/pdf', size: 1200 };
  const full = { ...orig, email: 'ronen@example.test', lease, leaseEnd: '2027-06-30' };

  it('the email, the lease and its end date are compared like the name: only what changed is sent', () => {
    expect(holderUpdatesForBlock(ids, { ...full }, full)).toEqual([]);
    expect(holderUpdatesForBlock(['c1'], { ...full, email: 'new@example.test' }, full)).toEqual([{ id: 'c1', holder_email: 'new@example.test' }]);
    expect(holderUpdatesForBlock(['c1'], { ...full, leaseEnd: '2028-01-31' }, full)).toEqual([{ id: 'c1', lease_end_date: '2028-01-31' }]);
    // A first email / lease on a block whose chips had none.
    expect(holderUpdatesForBlock(['c1'], { ...orig, email: 'a@example.test', lease, leaseEnd: null }, { ...orig, email: null, lease: null, leaseEnd: null }))
      .toEqual([{ id: 'c1', holder_email: 'a@example.test', lease }]);
  });

  it('a lease is its stored object: the same key is the same lease, another key replaces it, none takes it off', () => {
    // The block was seeded from its chips, which know the key and the name only.
    const seeded = { ...full, lease: { key: lease.key, name: lease.name, mime: null, size: null } };
    expect(holderUpdatesForBlock(['c1'], { ...full }, seeded)).toEqual([]);
    const other = { ...lease, key: '22222222-2222-4222-8222-222222222222.png', name: 'חדש.png' };
    expect(holderUpdatesForBlock(['c1'], { ...full, lease: other }, full)).toEqual([{ id: 'c1', lease: other }]);
    expect(holderUpdatesForBlock(['c1'], { ...full, lease: null }, full)).toEqual([{ id: 'c1', lease: null }]);
    expect(holderUpdatesForBlock(['c1'], { ...full, email: null }, full)).toEqual([{ id: 'c1', holder_email: null }]);
  });

  it('a caller that does not carry the three fields (the order window) never touches them', () => {
    expect(holderUpdatesForBlock(['c1'], { ...orig }, full)).toEqual([]);
    expect(holderUpdatesForBlock(['c1'], { ...orig, name: 'דנה' }, full)).toEqual([{ id: 'c1', holder_name: 'דנה' }]);
  });
});

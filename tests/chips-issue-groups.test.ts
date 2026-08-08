import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CHIPS_SOFT_LIMIT,
  countGroupNumbers,
  exceedsSoftLimit,
  findDuplicateNumber,
  legacyChipBodyToInput,
} from '@/lib/chips/issueGroups';
import type { IssueChipGroup } from '@/lib/types/chips';

// The multi-person issue window sends holder GROUPS (one per person+type; the
// client splits a mixed-type block into per-type groups). These helpers are
// the shared authority for: the soft-limit count over the SUM of all groups,
// cross-group duplicate detection, and the legacy flat-body adapter.

function group(partial: Partial<IssueChipGroup>): IssueChipGroup {
  return {
    resident_role: 'owner',
    chip_type: 'physical',
    numbers: [],
    ...partial,
  };
}

describe('exceedsSoftLimit — counted over the SUM of all groups', () => {
  it('trips past 4 actives regardless of how numbers split into groups', () => {
    // 2 existing actives + 3 new (2 physical + 1 app, SAME person split by
    // type) = 5 > 4 — the per-type split must NOT bypass the count.
    const groups = [
      group({ numbers: ['A-1', 'A-2'] }),
      group({ chip_type: 'app', numbers: ['A-3'] }),
    ];
    expect(countGroupNumbers(groups)).toBe(3);
    expect(exceedsSoftLimit(2, countGroupNumbers(groups))).toBe(true);
    expect(exceedsSoftLimit(1, countGroupNumbers(groups))).toBe(false);
  });

  it('blank entries do not count', () => {
    expect(countGroupNumbers([group({ numbers: ['A-1', ' ', ''] })])).toBe(1);
  });

  it('boundary: exactly at the limit is allowed', () => {
    expect(exceedsSoftLimit(ACTIVE_CHIPS_SOFT_LIMIT, 0)).toBe(false);
    expect(exceedsSoftLimit(ACTIVE_CHIPS_SOFT_LIMIT - 1, 1)).toBe(false);
    expect(exceedsSoftLimit(ACTIVE_CHIPS_SOFT_LIMIT, 1)).toBe(true);
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
  it('maps EVERY field, incl. limit_override_reason staying window-global', () => {
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
      limit_override_reason: 'משפחה מורחבת',
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
    expect(input.limit_override_reason).toBe('משפחה מורחבת');
  });

  it('legacy body over the soft limit WITH a reason passes the gate (clarification 2)', () => {
    // 4 existing actives + a 5th legacy number → over the limit; the adapted
    // input must carry the reason so the DB gate (exceeds && !reason) passes.
    const input = legacyChipBodyToInput({
      contact_id: 'c-1',
      chip_type: 'physical',
      chip_numbers: ['A-5'],
      resident_role: 'owner',
      limit_override_reason: 'עובד סיעודי',
    });
    const over = exceedsSoftLimit(4, countGroupNumbers(input.groups));
    expect(over).toBe(true);
    const gateBlocks = over && !(input.limit_override_reason?.trim());
    expect(gateBlocks).toBe(false);
  });

  it('same legacy body WITHOUT a reason is blocked by the gate', () => {
    const input = legacyChipBodyToInput({
      contact_id: 'c-1',
      chip_type: 'physical',
      chip_numbers: ['A-5'],
      resident_role: 'owner',
    });
    const over = exceedsSoftLimit(4, countGroupNumbers(input.groups));
    const gateBlocks = over && !(input.limit_override_reason?.trim());
    expect(gateBlocks).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { deriveChatLinkKind, normalizeChatLink } from '@/lib/whatsapp-link';
import { cleanPhoneField } from '@/lib/whatsapp';

// The XOR model for a WhatsApp conversation's link target. normalizeChatLink is
// the single source of truth used by setConversationLink (the DB relink
// primitive), so testing it here covers the real rule that "linking to a
// supplier clears debtor_id" (and the reverse) without needing the DB.

describe('deriveChatLinkKind — derive the link kind from the populated column', () => {
  it('debtor_id set → debtor', () => {
    expect(deriveChatLinkKind('d1', null)).toBe('debtor');
  });
  it('supplier_id set → supplier', () => {
    expect(deriveChatLinkKind(null, 's1')).toBe('supplier');
  });
  it('neither set → unlinked', () => {
    expect(deriveChatLinkKind(null, null)).toBe('unlinked');
    expect(deriveChatLinkKind(undefined, undefined)).toBe('unlinked');
  });
  it('debtor takes precedence over supplier (defensive; XOR makes this unreachable)', () => {
    expect(deriveChatLinkKind('d1', 's1')).toBe('debtor');
  });
});

describe('normalizeChatLink — XOR enforcement on every write', () => {
  it('linking to a supplier clears debtor_id', () => {
    expect(normalizeChatLink({ supplierId: 's1' })).toEqual({
      debtorId: null,
      supplierId: 's1',
      linkStatus: 'linked',
    });
  });

  it('linking to a debtor clears supplier_id (the reverse)', () => {
    expect(normalizeChatLink({ debtorId: 'd1' })).toEqual({
      debtorId: 'd1',
      supplierId: null,
      linkStatus: 'linked',
    });
  });

  it('a malformed call passing BOTH collapses to supplier-only (never both)', () => {
    const out = normalizeChatLink({ debtorId: 'd1', supplierId: 's1' });
    expect(out.supplierId).toBe('s1');
    expect(out.debtorId).toBeNull();
    expect(out.linkStatus).toBe('linked');
  });

  it('no target → unlinked (both null)', () => {
    expect(normalizeChatLink({})).toEqual({ debtorId: null, supplierId: null, linkStatus: 'unlinked' });
  });

  it('empty strings are treated as "absent" → unlinked', () => {
    expect(normalizeChatLink({ debtorId: '', supplierId: '' })).toEqual({
      debtorId: null,
      supplierId: null,
      linkStatus: 'unlinked',
    });
  });
});

describe('create-supplier-from-chat — the conversation number is cleaned before storage', () => {
  // The /create-supplier route feeds the conversation contact_phone through the
  // supplier validator, which cleans it with cleanPhoneField (same as the manual
  // supplier form). These assert the cleaning the route relies on.
  it('local form passes through unchanged', () => {
    expect(cleanPhoneField('0525460546')).toBe('0525460546');
  });
  it('international/markup/label forms collapse to one clean local number', () => {
    expect(cleanPhoneField('972525460546')).toBe('0525460546');
    expect(cleanPhoneField('+972 52-546-0546')).toBe('0525460546');
    expect(cleanPhoneField('0525460546 (בעלים)')).toBe('0525460546');
  });
});

import { describe, it, expect } from 'vitest';
import { coerceIssueInput } from '@/lib/validation/issues';

const USER = '11111111-1111-1111-1111-111111111111';
const SUPPLIER = '22222222-2222-2222-2222-222222222222';

describe('coerceIssueInput — mutually-exclusive handler (user XOR supplier)', () => {
  it('rejects when BOTH a user and a supplier are assigned', () => {
    const r = coerceIssueInput(
      { assigned_to_user_id: USER, supplier_id: SUPPLIER },
      'update',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('assignee_conflict');
  });

  it('assigning a supplier clears any internal user (even on a partial PATCH)', () => {
    const r = coerceIssueInput({ supplier_id: SUPPLIER }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.supplier_id).toBe(SUPPLIER);
      expect(r.fields.assigned_to_user_id).toBeNull();
    }
  });

  it('assigning a user clears any supplier (even on a partial PATCH)', () => {
    const r = coerceIssueInput({ assigned_to_user_id: USER }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.assigned_to_user_id).toBe(USER);
      expect(r.fields.supplier_id).toBeNull();
    }
  });

  it('"ללא שיוך" (both null) is allowed and forces neither', () => {
    const r = coerceIssueInput(
      { assigned_to_user_id: null, supplier_id: null },
      'update',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.assigned_to_user_id).toBeNull();
      expect(r.fields.supplier_id).toBeNull();
    }
  });

  it('does not touch assignee fields when neither is in the body', () => {
    const r = coerceIssueInput({ title: 'דליפה במרתף' }, 'create');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('assigned_to_user_id' in r.fields).toBe(false);
      expect('supplier_id' in r.fields).toBe(false);
    }
  });
});

describe('coerceIssueInput — supplier_id format', () => {
  it('rejects a non-uuid supplier_id', () => {
    const r = coerceIssueInput({ supplier_id: 'not-a-uuid' }, 'update');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_supplier_id');
  });

  it('accepts a valid supplier_id uuid', () => {
    const r = coerceIssueInput({ supplier_id: SUPPLIER }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.supplier_id).toBe(SUPPLIER);
  });

  it('rejects a non-uuid assigned_to_user_id', () => {
    const r = coerceIssueInput({ assigned_to_user_id: 'nope' }, 'update');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_assigned_to_user_id');
  });
});

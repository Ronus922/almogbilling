import { describe, it, expect } from 'vitest';
import { coerceTaskInput } from '@/lib/validation/tasks';

const USER = '11111111-1111-1111-1111-111111111111';
const SUPPLIER = '22222222-2222-2222-2222-222222222222';

describe('coerceTaskInput — mutually-exclusive handler (user XOR supplier)', () => {
  it('rejects when both a user and a supplier are assigned', () => {
    const r = coerceTaskInput(
      { title: 'נזילה', assigned_to_user_id: USER, supplier_id: SUPPLIER },
      'create',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('assignee_conflict');
  });

  it('assigning a supplier clears any internal user (partial PATCH)', () => {
    const r = coerceTaskInput({ supplier_id: SUPPLIER }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.supplier_id).toBe(SUPPLIER);
      expect(r.fields.assigned_to_user_id).toBeNull();
    }
  });

  it('assigning a user clears any supplier (partial PATCH)', () => {
    const r = coerceTaskInput({ assigned_to_user_id: USER }, 'update');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.assigned_to_user_id).toBe(USER);
      expect(r.fields.supplier_id).toBeNull();
    }
  });

  it('rejects a non-uuid supplier_id', () => {
    const r = coerceTaskInput({ supplier_id: 'not-a-uuid' }, 'update');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_supplier_id');
  });

  it('accepts a valid supplier_id and keeps the title', () => {
    const r = coerceTaskInput({ title: 'תיקון מעלית', supplier_id: SUPPLIER }, 'create');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.title).toBe('תיקון מעלית');
      expect(r.fields.supplier_id).toBe(SUPPLIER);
      expect(r.fields.assigned_to_user_id).toBeNull();
    }
  });

  it('title is still required on create', () => {
    const r = coerceTaskInput({}, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title_required');
  });

  it('does not touch handler fields when neither is in the body', () => {
    const r = coerceTaskInput({ title: 'משימה' }, 'create');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('assigned_to_user_id' in r.fields).toBe(false);
      expect('supplier_id' in r.fields).toBe(false);
    }
  });
});

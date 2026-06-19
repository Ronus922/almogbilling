import { describe, it, expect } from 'vitest';
import { coerceTaskInput } from '@/lib/validation/tasks';

const SUPPLIER = '22222222-2222-2222-2222-222222222222';

describe('coerceTaskInput — assignees moved to the junction', () => {
  it('no longer treats assigned_to_user_id / supplier_id as task fields', () => {
    const r = coerceTaskInput(
      { title: 'נזילה', assigned_to_user_id: SUPPLIER, supplier_id: SUPPLIER },
      'create',
    );
    // The legacy keys are ignored entirely — no XOR conflict, no scalar field set.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('assigned_to_user_id' in r.fields).toBe(false);
      expect('supplier_id' in r.fields).toBe(false);
    }
  });

  it('title is still required on create', () => {
    const r = coerceTaskInput({}, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title_required');
  });

  it('still validates the non-assignee fields (e.g. status)', () => {
    const r = coerceTaskInput({ title: 'x', status: 'nope' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_status');
  });

  it('keeps debtor_id / related_entity_id coercion intact', () => {
    const r = coerceTaskInput({ debtor_id: 'not-a-uuid' }, 'update');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_debtor_id');
  });
});

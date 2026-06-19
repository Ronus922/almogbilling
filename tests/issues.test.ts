import { describe, it, expect } from 'vitest';
import { coerceIssueInput } from '@/lib/validation/issues';

const SUPPLIER = '22222222-2222-2222-2222-222222222222';

describe('coerceIssueInput — assignees moved to the junction', () => {
  it('no longer treats assigned_to_user_id / supplier_id as issue fields', () => {
    const r = coerceIssueInput(
      { title: 'דליפה', assigned_to_user_id: SUPPLIER, supplier_id: SUPPLIER },
      'create',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('assigned_to_user_id' in r.fields).toBe(false);
      expect('supplier_id' in r.fields).toBe(false);
    }
  });

  it('title is still required on create', () => {
    const r = coerceIssueInput({}, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('title_required');
  });

  it('still validates non-assignee fields (e.g. priority)', () => {
    const r = coerceIssueInput({ title: 'x', priority: 'nope' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_priority');
  });

  it('resolving requires resolution notes on create', () => {
    const r = coerceIssueInput({ title: 'x', status: 'resolved' }, 'create');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('resolution_notes_required');
  });
});

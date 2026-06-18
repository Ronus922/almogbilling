import { describe, it, expect } from 'vitest';
import { assertSingleAssignee, type AssigneeFields } from '@/lib/validation/assignee';

const U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const S = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('assertSingleAssignee — shared user-XOR-supplier rule', () => {
  it('rejects when BOTH a user and a supplier are set', () => {
    expect(assertSingleAssignee({ assigned_to_user_id: U, supplier_id: S })).toBe('assignee_conflict');
  });

  it('setting a supplier clears the user (added as null)', () => {
    const f: AssigneeFields = { supplier_id: S };
    expect(assertSingleAssignee(f)).toBeNull();
    expect(f.supplier_id).toBe(S);
    expect(f.assigned_to_user_id).toBeNull();
  });

  it('setting a user clears the supplier (added as null)', () => {
    const f: AssigneeFields = { assigned_to_user_id: U };
    expect(assertSingleAssignee(f)).toBeNull();
    expect(f.assigned_to_user_id).toBe(U);
    expect(f.supplier_id).toBeNull();
  });

  it('neither set → untouched (no keys added)', () => {
    const f: AssigneeFields = {};
    expect(assertSingleAssignee(f)).toBeNull();
    expect('assigned_to_user_id' in f).toBe(false);
    expect('supplier_id' in f).toBe(false);
  });

  it('both explicitly null ("ללא שיוך") → ok, both stay null', () => {
    const f: AssigneeFields = { assigned_to_user_id: null, supplier_id: null };
    expect(assertSingleAssignee(f)).toBeNull();
    expect(f.assigned_to_user_id).toBeNull();
    expect(f.supplier_id).toBeNull();
  });
});

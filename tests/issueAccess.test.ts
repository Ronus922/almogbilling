import { describe, it, expect } from 'vitest';
import {
  issueScopeUserId,
  actorMayAccessIssue,
  actorMayAccessIssueByUserIds,
} from '@/lib/auth/issueAccess';
import type { Role } from '@/lib/permissions/constants';
import type { AssigneeRef } from '@/lib/types/assignee';

// The row-level isolation core. The async DB path (actorMayAccessIssueId) and the
// per-route HTTP codes (read → 404, write → 403) are integration behavior verified
// live after deploy; these unit tests pin the decision logic that every route shares.

const actor = (role: Role, id: string) => ({ role, id });

const userA: AssigneeRef = { assignee_type: 'user', user_id: 'u-A', supplier_id: null, display_name: null, email: null, phone: null };
const userB: AssigneeRef = { assignee_type: 'user', user_id: 'u-B', supplier_id: null, display_name: null, email: null, phone: null };
const supplierA: AssigneeRef = { assignee_type: 'supplier', user_id: null, supplier_id: 'u-A', display_name: null, email: null, phone: null };

describe('issueScopeUserId — who is row-scoped', () => {
  it('field workers are scoped to their own id', () => {
    expect(issueScopeUserId(actor('cleaner', 'u-A'))).toBe('u-A');
    expect(issueScopeUserId(actor('maintenance', 'u-B'))).toBe('u-B');
  });

  it('every non-worker role is unrestricted (null)', () => {
    for (const role of ['super_admin', 'admin', 'manager', 'viewer'] as const) {
      expect(issueScopeUserId(actor(role, 'u-A'))).toBeNull();
    }
  });
});

describe('actorMayAccessIssue — from a loaded assignee set', () => {
  it('a worker may access an issue they are a USER-assignee of', () => {
    expect(actorMayAccessIssue(actor('cleaner', 'u-A'), [userA])).toBe(true);
    // membership, not sole-assignment: worker alongside other users still passes.
    expect(actorMayAccessIssue(actor('maintenance', 'u-B'), [userA, userB])).toBe(true);
  });

  it('a worker may NOT access an issue they are not assigned to', () => {
    expect(actorMayAccessIssue(actor('cleaner', 'u-A'), [userB])).toBe(false);
    expect(actorMayAccessIssue(actor('cleaner', 'u-A'), [])).toBe(false);
  });

  it('a supplier row sharing the worker id does NOT grant access (user-kind only)', () => {
    // u-A appears as a SUPPLIER here, not a user — a worker login must not match it.
    expect(actorMayAccessIssue(actor('cleaner', 'u-A'), [supplierA])).toBe(false);
  });

  it('managers/admins are unrestricted regardless of the assignee set', () => {
    expect(actorMayAccessIssue(actor('manager', 'u-X'), [])).toBe(true);
    expect(actorMayAccessIssue(actor('admin', 'u-X'), [userB])).toBe(true);
    expect(actorMayAccessIssue(actor('super_admin', 'u-X'), [])).toBe(true);
  });
});

describe('actorMayAccessIssueByUserIds — from loaded user ids (PATCH path)', () => {
  it('a worker passes iff their id is among the assignee ids', () => {
    expect(actorMayAccessIssueByUserIds(actor('cleaner', 'u-A'), ['u-A', 'u-B'])).toBe(true);
    expect(actorMayAccessIssueByUserIds(actor('cleaner', 'u-A'), ['u-B'])).toBe(false);
    expect(actorMayAccessIssueByUserIds(actor('cleaner', 'u-A'), [])).toBe(false);
  });

  it('managers/admins are unrestricted', () => {
    expect(actorMayAccessIssueByUserIds(actor('manager', 'u-X'), [])).toBe(true);
    expect(actorMayAccessIssueByUserIds(actor('super_admin', 'u-X'), ['u-B'])).toBe(true);
  });
});

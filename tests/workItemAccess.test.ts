import { describe, it, expect } from 'vitest';
import {
  actorMayAccessWorkItem,
  manageableRolesFor,
  isUnscopedActor,
  workItemScopeSql,
} from '@/lib/auth/workItemAccess';
import type { Role } from '@/lib/permissions/constants';

// The unified module's row-level isolation core (11/10/2026) — REPLACES the
// issues-only issueAccess for every route that moved to it. Pins the decision
// logic every route/query shares: super_admin unrestricted; admin/manager
// scoped to {own, unassigned, supplier-assigned, assigned-to-a-manageable-role};
// worker/viewer scoped to {own, created-by-self} only. See Decisions Log
// 11/10/2026 — intentionally narrower than today's unrestricted admin/manager
// access to issues/tasks.

const actor = (role: Role, id: string) => ({ role, id });
const row = (p: Partial<{ assignee_user_id: string | null; assignee_supplier_id: string | null; created_by: string | null }>) => ({
  assignee_user_id: null, assignee_supplier_id: null, created_by: null, ...p,
});

describe('manageableRolesFor', () => {
  it('admin manages manager/viewer/cleaner/maintenance, never admin/super_admin', () => {
    expect(manageableRolesFor('admin').sort()).toEqual(['cleaner', 'maintenance', 'manager', 'viewer'].sort());
  });
  it('manager manages nobody — canManageRole is an account-management predicate, reused as-is', () => {
    expect(manageableRolesFor('manager')).toEqual([]);
  });
  it('super_admin: irrelevant (isUnscopedActor short-circuits before this is consulted)', () => {
    expect(isUnscopedActor('super_admin')).toBe(true);
    expect(isUnscopedActor('admin')).toBe(false);
  });
});

describe('actorMayAccessWorkItem — super_admin', () => {
  it('unrestricted regardless of the row', () => {
    expect(actorMayAccessWorkItem(actor('super_admin', 'u-X'), row({ assignee_user_id: 'u-other' }))).toBe(true);
  });
});

describe('actorMayAccessWorkItem — worker / viewer (self-scoped)', () => {
  it('may access an item assigned to them', () => {
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({ assignee_user_id: 'u-A' }))).toBe(true);
    expect(actorMayAccessWorkItem(actor('viewer', 'u-A'), row({ assignee_user_id: 'u-A' }))).toBe(true);
  });
  it('may access an item they created, even unassigned or assigned to someone else', () => {
    expect(actorMayAccessWorkItem(actor('maintenance', 'u-A'), row({ created_by: 'u-A' }))).toBe(true);
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({ created_by: 'u-A', assignee_user_id: 'u-B' }))).toBe(true);
  });
  it('may NOT access an unassigned item they did not create (no "ממתין לשיוך" visibility for workers)', () => {
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({}))).toBe(false);
  });
  it('may NOT access an item assigned to a supplier', () => {
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({ assignee_supplier_id: 's-1' }))).toBe(false);
  });
  it('may NOT access another user\'s item', () => {
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({ assignee_user_id: 'u-B' }))).toBe(false);
  });
});

describe('actorMayAccessWorkItem — admin/manager in-process clauses', () => {
  it('may access their own item (created or assigned)', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({ created_by: 'u-A' }))).toBe(true);
    expect(actorMayAccessWorkItem(actor('admin', 'u-A'), row({ assignee_user_id: 'u-A' }))).toBe(true);
  });
  it('may access an unassigned item', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({}))).toBe(true);
  });
  it('may access a supplier-assigned item', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({ assignee_supplier_id: 's-1' }))).toBe(true);
  });
  it('the role-scoped clause (assignee held by a role they manage) needs an async role lookup — in-process check alone returns false, not a grant', () => {
    expect(actorMayAccessWorkItem(actor('admin', 'u-A'), row({ assignee_user_id: 'u-other' }))).toBe(false);
  });
});

describe('workItemScopeSql — SQL fragment shape', () => {
  it('super_admin gets no restriction at all', () => {
    expect(workItemScopeSql(actor('super_admin', 'u-A'), 'combined', 0)).toEqual({ sql: '', params: [] });
  });
  it('a worker gets a self-or-created clause parameterized with their own id', () => {
    const { sql, params } = workItemScopeSql(actor('cleaner', 'u-A'), 'combined', 2);
    expect(sql).toContain('combined.assignee_user_id = $3');
    expect(sql).toContain('combined.created_by = $3');
    expect(params).toEqual(['u-A']);
  });
  it('an admin gets the manageable-roles array + own id, numbered after the offset', () => {
    const { sql, params } = workItemScopeSql(actor('admin', 'u-A'), 'combined', 1);
    expect(sql).toContain('$2::text[]'); // manageable roles array
    expect(sql).toContain('$3'); // actor id
    expect(params[0]).toEqual(expect.arrayContaining(['manager', 'viewer', 'cleaner', 'maintenance']));
    expect(params[1]).toBe('u-A');
  });
});

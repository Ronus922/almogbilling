import { describe, it, expect } from 'vitest';
import {
  actorMayAccessWorkItem,
  actorMayAccessWorkItemAsync,
  isUnscopedActor,
  workItemScopeSql,
} from '@/lib/auth/workItemAccess';
import type { Role } from '@/lib/permissions/constants';

// תקלות/משימות row-level isolation (12/10/2026, Decisions Log: "עיצוב משותף,
// ישויות נפרדות") — REPLACES the 11/10/2026 formula for admin/manager with a
// narrower one: an item they created, are the primary assignee of, or that
// they themselves assigned (entity_assignees.assigned_by) — no more blanket
// access to every unassigned/supplier-assigned/role-managed item. worker and
// viewer are unchanged from 11/10/2026: self (primary assignee) or
// created-by-self only, nothing else.

const actor = (role: Role, id: string) => ({ role, id });
const row = (p: Partial<{ assignee_user_id: string | null; assignee_supplier_id: string | null; created_by: string | null }>) => ({
  assignee_user_id: null, assignee_supplier_id: null, created_by: null, ...p,
});

describe('actorMayAccessWorkItem — super_admin', () => {
  it('unrestricted regardless of the row', () => {
    expect(actorMayAccessWorkItem(actor('super_admin', 'u-X'), row({ assignee_user_id: 'u-other' }))).toBe(true);
  });
  it('isUnscopedActor is true only for super_admin', () => {
    expect(isUnscopedActor('super_admin')).toBe(true);
    expect(isUnscopedActor('admin')).toBe(false);
    expect(isUnscopedActor('manager')).toBe(false);
  });
});

describe('actorMayAccessWorkItem — worker / viewer (self-scoped, unchanged from 11/10/2026)', () => {
  it('may access an item assigned to them (primary assignee)', () => {
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
  it('may NOT access another user\'s item, and the async "assigned_by me" clause never runs for them', async () => {
    expect(actorMayAccessWorkItem(actor('cleaner', 'u-A'), row({ assignee_user_id: 'u-B' }))).toBe(false);
    const lookup = () => { throw new Error('must not be called for a self-scoped actor'); };
    await expect(actorMayAccessWorkItemAsync(actor('viewer', 'u-A'), row({ assignee_user_id: 'u-B' }), lookup)).resolves.toBe(false);
  });
});

describe('actorMayAccessWorkItem — admin/manager, narrower than 11/10/2026', () => {
  it('may access their own item (created or primary-assigned)', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({ created_by: 'u-A' }))).toBe(true);
    expect(actorMayAccessWorkItem(actor('admin', 'u-A'), row({ assignee_user_id: 'u-A' }))).toBe(true);
  });
  it('may NOT access an unassigned item they did not create — REVERSED from 11/10/2026', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({}))).toBe(false);
  });
  it('may NOT access a supplier-assigned item they did not create/assign — REVERSED from 11/10/2026', () => {
    expect(actorMayAccessWorkItem(actor('manager', 'u-A'), row({ assignee_supplier_id: 's-1' }))).toBe(false);
  });
  it('the in-process check alone never grants access on someone else\'s item — the "assigned_by me" clause needs the async junction lookup', () => {
    expect(actorMayAccessWorkItem(actor('admin', 'u-A'), row({ assignee_user_id: 'u-other' }))).toBe(false);
  });
});

describe('actorMayAccessWorkItemAsync — the "assigned_by me" clause (12/10/2026)', () => {
  it('admin/manager: granted when they performed the assignment write, even though someone else ends up assigned', async () => {
    const wasAssignedByMe = async () => true;
    await expect(
      actorMayAccessWorkItemAsync(actor('manager', 'u-A'), row({ assignee_user_id: 'u-other' }), wasAssignedByMe),
    ).resolves.toBe(true);
  });
  it('admin/manager: denied when neither the in-process clauses nor the junction lookup match', async () => {
    const wasAssignedByMe = async () => false;
    await expect(
      actorMayAccessWorkItemAsync(actor('admin', 'u-A'), row({ assignee_user_id: 'u-other' }), wasAssignedByMe),
    ).resolves.toBe(false);
  });
  it('super_admin: the lookup is never consulted (in-process check already decided true)', async () => {
    const lookup = () => { throw new Error('must not be called for an unscoped actor'); };
    await expect(
      actorMayAccessWorkItemAsync(actor('super_admin', 'u-A'), row({ assignee_user_id: 'u-other' }), lookup),
    ).resolves.toBe(true);
  });
});

describe('workItemScopeSql — SQL fragment shape', () => {
  it('super_admin gets no restriction at all', () => {
    expect(workItemScopeSql(actor('super_admin', 'u-A'), 'scoped', 0, 'issue')).toEqual({ sql: '', params: [] });
  });
  it('a worker gets a self-or-created clause parameterized with their own id', () => {
    const { sql, params } = workItemScopeSql(actor('cleaner', 'u-A'), 'scoped', 2, 'task');
    expect(sql).toContain('scoped.assignee_user_id = $3');
    expect(sql).toContain('scoped.created_by = $3');
    expect(params).toEqual(['u-A']);
  });
  it('an admin gets created_by OR primary-assignee OR an assigned_by EXISTS against entity_assignees, scoped to the given entityType', () => {
    const { sql, params } = workItemScopeSql(actor('admin', 'u-A'), 'scoped', 1, 'issue');
    expect(sql).toContain('scoped.created_by = $2');
    expect(sql).toContain('scoped.assignee_user_id = $2');
    expect(sql).toContain("ea.entity_type = 'issue'");
    expect(sql).toContain('ea.assigned_by = $2');
    expect(params).toEqual(['u-A']);
  });
});

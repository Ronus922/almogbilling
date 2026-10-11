import 'server-only';
import { canManageRole } from '@/lib/permissions/check';
import { isWorkerRole, ROLE_VALUES, type Role } from '@/lib/permissions/constants';

/**
 * Row-level visibility for the unified תקלות/משימות module (11/10/2026),
 * shared by `issues` and `tasks`. This REPLACES the narrower, issues-only
 * `src/lib/auth/issueAccess.ts` scoping for every route that moves to the new
 * module — see Decisions Log 11/10/2026: the new target model replaces
 * whatever broader visibility existed before, on either table.
 *
 * - super_admin: unrestricted.
 * - admin / manager: items whose primary assignee is a user in a role they
 *   `canManageRole` over (admin → manager/viewer/cleaner/maintenance; manager
 *   → none — canManageRole is strictly about MANAGING ACCOUNTS, reused
 *   verbatim here, so a manager's own formula contributes nothing beyond the
 *   next three clauses), PLUS items they are the primary assignee of or
 *   created, PLUS unassigned items, PLUS supplier-assigned items.
 *   This is narrower than today's unrestricted admin/manager access to
 *   issues/tasks — intentional, per the 11/10/2026 decision.
 * - cleaner / maintenance (worker) and viewer: items they are the primary
 *   assignee of, or created. Read-only for viewer (module gate elsewhere).
 */
export interface WorkItemScopeActor {
  role: Role;
  id: string;
}

export interface WorkItemRow {
  assignee_user_id: string | null;
  assignee_supplier_id: string | null;
  created_by: string | null;
}

/** Roles this actor may administer accounts for — reused as the data-scope
 *  "scope by canManageRole" clause. Empty for every role except admin. */
export function manageableRolesFor(actorRole: Role): Role[] {
  return ROLE_VALUES.filter((r) => canManageRole(actorRole, r));
}

/** True when the actor is unrestricted (sees every issue/task). */
export function isUnscopedActor(actorRole: Role): boolean {
  return actorRole === 'super_admin';
}

/** True when the actor's scope is "assigned-to-me or created-by-me only"
 *  (worker and viewer — same shape, viewer is additionally read-only). */
function isSelfScopedActor(actorRole: Role): boolean {
  return isWorkerRole(actorRole) || actorRole === 'viewer';
}

/**
 * In-process access check from an already-loaded row — for routes that
 * fetched the full item (single GET, PATCH, DELETE). No extra query.
 */
export function actorMayAccessWorkItem(actor: WorkItemScopeActor, row: WorkItemRow): boolean {
  if (isUnscopedActor(actor.role)) return true;
  if (row.created_by === actor.id) return true;
  if (row.assignee_user_id === actor.id) return true;
  if (isSelfScopedActor(actor.role)) return false;
  // admin / manager clauses: unassigned, supplier-assigned, or assigned to a
  // role they manage.
  if (row.assignee_user_id === null && row.assignee_supplier_id === null) return true;
  if (row.assignee_supplier_id !== null) return true;
  return false; // the caller resolves the assignee's role async (see below) when this is false
}

/**
 * SQL WHERE fragment (+ params, starting at $paramOffset+1) restricting a
 * list query to what this actor may see. Returns `{ sql: '', params: [] }`
 * for an unrestricted actor (super_admin) — append nothing.
 *
 * `alias` is a fixed identifier (never user input). Assumes `alias.assignee_user_id`,
 * `alias.assignee_supplier_id`, `alias.created_by` exist on the target table.
 */
export function workItemScopeSql(
  actor: WorkItemScopeActor,
  alias: string,
  paramOffset: number,
): { sql: string; params: unknown[] } {
  if (isUnscopedActor(actor.role)) return { sql: '', params: [] };

  if (isSelfScopedActor(actor.role)) {
    return {
      sql: `and (${alias}.assignee_user_id = $${paramOffset + 1} or ${alias}.created_by = $${paramOffset + 1})`,
      params: [actor.id],
    };
  }

  // admin / manager
  const manageable = manageableRolesFor(actor.role);
  const roleParam = paramOffset + 1;
  const idParam = paramOffset + 2;
  return {
    sql: `and (
      ${alias}.created_by = $${idParam}
      or ${alias}.assignee_user_id = $${idParam}
      or (${alias}.assignee_user_id is null and ${alias}.assignee_supplier_id is null)
      or ${alias}.assignee_supplier_id is not null
      or ${alias}.assignee_user_id in (select id from public.users where role = any($${roleParam}::text[]))
    )`,
    params: [manageable, actor.id],
  };
}

/**
 * Async access decision for routes that did NOT load the full row (comments,
 * attachments) — resolves the assignee's role only when needed (admin/manager
 * whose in-process clauses above didn't already decide it).
 */
export async function actorMayAccessWorkItemAsync(
  actor: WorkItemScopeActor,
  row: WorkItemRow,
  lookupAssigneeRole: (userId: string) => Promise<Role | null>,
): Promise<boolean> {
  const quick = actorMayAccessWorkItem(actor, row);
  if (quick) return true;
  if (isUnscopedActor(actor.role) || isSelfScopedActor(actor.role)) return quick;
  if (row.assignee_user_id === null) return quick; // already handled above (unassigned → true)
  const role = await lookupAssigneeRole(row.assignee_user_id);
  if (!role) return false;
  return canManageRole(actor.role, role);
}


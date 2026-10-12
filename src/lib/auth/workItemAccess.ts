import 'server-only';
import { isWorkerRole, type Role } from '@/lib/permissions/constants';

/**
 * Row-level visibility for תקלות (issues) and משימות (tasks) — now two
 * separate screens (12/10/2026, Decisions Log: "עיצוב משותף, ישויות נפרדות"
 * cancels the 11/10/2026 unification), sharing this one access module because
 * the visibility RULE is identical on both, not because the data is.
 *
 * - super_admin: unrestricted.
 * - admin / manager: an item they created, that is assigned to them (primary
 *   assignee), OR that they assigned to anyone (entity_assignees.assigned_by
 *   = them) — including someone else. This REPLACES the 11/10/2026 formula
 *   (which also included every unassigned item, every supplier-assigned item,
 *   and every item assigned to a role they `canManageRole` over) with a
 *   narrower one, per owner decision 12/10/2026. Known gap: `assigned_by` is
 *   NULL on every entity_assignees row written before the 12/10/2026
 *   migration, so for those historical rows this clause contributes nothing —
 *   visibility there falls back to created_by ∪ primary-assignee only.
 * - cleaner / maintenance (worker) and viewer: items they are the primary
 *   assignee of, or created. Unchanged from 11/10/2026. Read-only for viewer
 *   (module gate elsewhere).
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
 * fetched the full item (single GET, PATCH, DELETE). Covers every clause
 * EXCEPT "assigned_by me", which needs a junction-table lookup the caller
 * does not have from the row alone — see `actorMayAccessWorkItemAsync`.
 */
export function actorMayAccessWorkItem(actor: WorkItemScopeActor, row: WorkItemRow): boolean {
  if (isUnscopedActor(actor.role)) return true;
  if (row.created_by === actor.id) return true;
  if (row.assignee_user_id === actor.id) return true;
  return false;
}

/**
 * Full access decision, including the "assigned_by me" clause for admin/
 * manager — needs one query against entity_assignees when the in-process
 * check above did not already decide it (never for super_admin/worker/viewer,
 * who are fully decided without it).
 */
export async function actorMayAccessWorkItemAsync(
  actor: WorkItemScopeActor,
  row: WorkItemRow,
  actorAssignedThisEntity: () => Promise<boolean>,
): Promise<boolean> {
  if (actorMayAccessWorkItem(actor, row)) return true;
  if (isUnscopedActor(actor.role) || isSelfScopedActor(actor.role)) return false;
  return actorAssignedThisEntity();
}

/**
 * SQL WHERE fragment (+ params, starting at $paramOffset+1) restricting a
 * list query to what this actor may see. Returns `{ sql: '', params: [] }`
 * for an unrestricted actor (super_admin) — append nothing.
 *
 * `alias` is a fixed identifier (never user input). Assumes `alias.assignee_user_id`,
 * `alias.assignee_supplier_id` (unused by this function, kept for row-shape
 * parity with `WorkItemRow`), `alias.created_by` and `alias.id` exist on the
 * target table/CTE. `entityType` is the fixed literal `'issue'` or `'task'`
 * (never user input) identifying the row in `entity_assignees`.
 */
export function workItemScopeSql(
  actor: WorkItemScopeActor,
  alias: string,
  paramOffset: number,
  entityType: 'issue' | 'task',
): { sql: string; params: unknown[] } {
  if (isUnscopedActor(actor.role)) return { sql: '', params: [] };

  if (isSelfScopedActor(actor.role)) {
    return {
      sql: `and (${alias}.assignee_user_id = $${paramOffset + 1} or ${alias}.created_by = $${paramOffset + 1})`,
      params: [actor.id],
    };
  }

  // admin / manager
  const idParam = paramOffset + 1;
  return {
    sql: `and (
      ${alias}.created_by = $${idParam}
      or ${alias}.assignee_user_id = $${idParam}
      or exists (
        select 1 from public.entity_assignees ea
         where ea.entity_type = '${entityType}' and ea.entity_id = ${alias}.id
           and ea.assigned_by = $${idParam}
      )
    )`,
    params: [actor.id],
  };
}

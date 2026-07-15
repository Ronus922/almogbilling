import 'server-only';
import { isWorkerRole, type Role } from '@/lib/permissions/constants';
import { listEntityUserIds } from '@/lib/db/entityAssignees';
import type { AssigneeRef } from '@/lib/types/assignee';

/**
 * Row-level scope for the issues module — the single source of the "which issues
 * may this actor touch" decision, used by EVERY issue-returning and
 * issue-mutating route.
 *
 * The permission matrix answers a different question: "may this role touch the
 * issues MODULE at all" (issues:view / issues:edit). It says nothing about WHICH
 * issues. A field worker (cleaner/maintenance) holds issues:view+edit so they can
 * work their own faults — but `?assignedTo=` is a filter, not a boundary, so
 * without this every worker could read, edit, or delete any issue by id. This
 * module closes that: a worker is scoped to issues they are assigned to; manager
 * / admin / super_admin are unrestricted.
 *
 * "Assigned to" = the actor is among the issue's USER assignees in
 * entity_assignees (migration 047). Suppliers are external parties with no login,
 * so they never enter this test. The many-to-many model is not ambiguous here —
 * the question is only "is the actor ONE OF the assignees", a plain membership.
 */
interface ScopeActor {
  role: Role;
  id: string;
}

/**
 * The user id to scope issue access by, or null when the actor sees every issue.
 * null (manager/admin/super_admin) lets every check below short-circuit to
 * "allowed" WITHOUT touching the DB — so this restriction adds zero cost to the
 * roles that don't have it.
 */
export function issueScopeUserId(actor: ScopeActor): string | null {
  return isWorkerRole(actor.role) ? actor.id : null;
}

/**
 * Access decision from an already-loaded assignee set — for routes that fetched
 * the full issue (single GET, DELETE, create-task). No extra query.
 */
export function actorMayAccessIssue(actor: ScopeActor, assignees: readonly AssigneeRef[]): boolean {
  const scoped = issueScopeUserId(actor);
  if (scoped === null) return true;
  return assignees.some((a) => a.assignee_type === 'user' && a.user_id === scoped);
}

/**
 * Access decision from already-loaded user-assignee ids — for the PATCH route,
 * which reads getIssueAssigneeStatus().assignedUserIds before mutating. No extra
 * query.
 */
export function actorMayAccessIssueByUserIds(actor: ScopeActor, userIds: readonly string[]): boolean {
  const scoped = issueScopeUserId(actor);
  if (scoped === null) return true;
  return userIds.includes(scoped);
}

/**
 * Async access decision for routes that did NOT load the issue's assignees
 * (comments GET, images POST/DELETE). Queries the junction ONLY for a scoped
 * worker; a manager short-circuits with no DB hit. Existence is the caller's
 * concern — a non-existent issue has no assignees, so a worker gets `false`
 * (→ the caller's 404/403), which is the correct answer either way.
 */
export async function actorMayAccessIssueId(actor: ScopeActor, issueId: string): Promise<boolean> {
  const scoped = issueScopeUserId(actor);
  if (scoped === null) return true;
  const userIds = await listEntityUserIds('issue', issueId);
  return userIds.includes(scoped);
}

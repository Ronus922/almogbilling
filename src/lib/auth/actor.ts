import 'server-only';
import { query } from '@/lib/db';
import { getSession, type SessionUser } from './session';
import { AuthorizationError } from './errors';
import {
  hasPermission, canManageRole, canUseAssistant, canDeleteUsers, canUseNotifications,
  canViewVisitors, canCreateVisitorScan, canEditVisitorNotes, canManageVisitorScans,
} from '@/lib/permissions/check';
import { isGuardRole, isMatrixRole } from '@/lib/permissions/constants';
import type { Action, ModulePermission, Role } from '@/lib/permissions/constants';

export interface Actor extends SessionUser {
  permissions: ModulePermission[];
  isAuthenticated: true;
}

interface PermissionRow {
  module: string;
  can_view: boolean;
  can_edit: boolean;
}

export async function getCurrentActor(): Promise<Actor | null> {
  const session = await getSession();
  if (!session) return null;

  const u = session.user;
  let permissions: ModulePermission[] = [];

  if (isMatrixRole(u.role)) {
    const r = await query<PermissionRow>(
      `select module, can_view, can_edit
         from public.user_permissions
         where user_id = $1`,
      [u.id],
    );
    permissions = r.rows.map((row) => ({
      module: row.module,
      canView: row.can_view,
      canEdit: row.can_edit,
    }));
  }

  return {
    ...u,
    permissions,
    isAuthenticated: true,
  };
}

export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) throw new AuthorizationError('לא מחובר', 401);
  return actor;
}

/** super_admin or admin. */
export async function requireAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.role !== 'super_admin' && actor.role !== 'admin') {
    throw new AuthorizationError('דרושה הרשאת מנהל');
  }
  return actor;
}

/** The permanent deletion of a staff user (DELETE /api/users/[id]) — the
 *  USER_DELETE_ROLES allowlist (super admin only, 06/10/2026). 401 with no
 *  session, 403 for every other role. */
export async function requireUserDeleteAccess(): Promise<Actor> {
  const actor = await requireActor();
  if (!canDeleteUsers(actor.role)) {
    throw new AuthorizationError('מחיקת משתמש לצמיתות — לסופר אדמין בלבד');
  }
  return actor;
}

export async function requirePermission(module: string, action: Action): Promise<Actor> {
  const actor = await requireActor();
  if (!hasPermission(actor.role, actor.permissions, module, action)) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

/**
 * Pass if the actor satisfies ANY of the given module/action checks (logical OR).
 * For endpoints that legitimately serve more than one module — e.g. the debtors
 * screen reads, which a `dashboard` viewer OR a `contacts` manager may read, or
 * the target picker (`tasks` OR `issues`). Additive only: it never narrows an
 * existing single-module guard, so higher roles keep their current access.
 */
export async function requireAnyPermission(
  checks: ReadonlyArray<{ module: string; action: Action }>,
): Promise<Actor> {
  const actor = await requireActor();
  if (checks.some((c) => hasPermission(actor.role, actor.permissions, c.module, c.action))) {
    return actor;
  }
  throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
}

/**
 * Notifications (bell + /notifications) are personal infrastructure, not an RBAC
 * matrix module — so they're available to every role EXCEPT the read-only
 * `viewer`, who is scoped to the debtors screen only. Same contract as
 * requireActor() but fails closed for viewers, keeping the API consistent with
 * the hidden bell + the /notifications redirect.
 */
export async function requireNotificationsAccess(): Promise<Actor> {
  const actor = await requireActor();
  // canUseNotifications: not the viewer, and not the single-screen guard.
  if (!canUseNotifications(actor.role)) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

/**
 * `requireActor()` for the few routes that carry no module permission of their
 * own (sync status, global search) and so would otherwise be open to EVERY
 * signed-in role. The guard — whose whole access is the visitor-scan screen —
 * gets 403 here; every other role keeps what it had.
 */
export async function requireNonGuardActor(): Promise<Actor> {
  const actor = await requireActor();
  if (isGuardRole(actor.role)) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

/** The guard's own account only (password change): 403 for every other role. */
export async function requireGuardActor(): Promise<Actor> {
  const actor = await requireActor();
  if (!isGuardRole(actor.role)) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

// ── Visitor scan ("סריקת כניסה") — by ROLE, see VISITOR_*_ROLES ──────────────
/** Read rows and open the photo of a document (/api/files/visitor-ids). */
export async function requireVisitorView(): Promise<Actor> {
  const actor = await requireActor();
  // Guard, admin, super admin — none of them has a matrix to empty, so the role is the whole test.
  if (!canViewVisitors(actor.role)) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  return actor;
}

/** Scan a document: OCR and create a row. */
export async function requireVisitorCreate(): Promise<Actor> {
  const actor = await requireActor();
  if (!canCreateVisitorScan(actor.role)) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  return actor;
}

/** Change a row afterwards. A guard (notes only) passes; the route then checks
 *  that the body touches nothing but `notes` unless canManageVisitorScans. */
export async function requireVisitorEdit(): Promise<Actor> {
  const actor = await requireActor();
  if (!canEditVisitorNotes(actor.role)) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  return actor;
}

/** Delete a row with its photo. */
export async function requireVisitorManage(): Promise<Actor> {
  const actor = await requireActor();
  if (!canManageVisitorScans(actor.role)) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  return actor;
}

/**
 * The personal assistant (/api/agent/*) is STAFF-ONLY: it answers with other
 * residents' debts, so a resident must never reach it. Role allowlist
 * (ASSISTANT_ROLES) AND the debtors-screen permission gate — canUseAssistant().
 * 401 without a session, 403 for any role off the list (a future resident role
 * included) or any staff user without dashboard/contacts view.
 */
export async function requireAssistantAccess(): Promise<Actor> {
  const actor = await requireActor();
  if (!canUseAssistant(actor.role, actor.permissions)) {
    throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
  }
  return actor;
}

export async function requireCanManageRole(targetRole: Role): Promise<Actor> {
  const actor = await requireActor();
  if (!canManageRole(actor.role, targetRole)) {
    throw new AuthorizationError('אין הרשאה לנהל תפקיד זה');
  }
  return actor;
}

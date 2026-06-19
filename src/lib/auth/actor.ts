import 'server-only';
import { query } from '@/lib/db';
import { getSession, type SessionUser } from './session';
import { AuthorizationError } from './errors';
import { hasPermission, canManageRole } from '@/lib/permissions/check';
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

  if (u.role === 'manager' || u.role === 'viewer') {
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

export async function requireSuperAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.role !== 'super_admin') {
    throw new AuthorizationError('דרושה הרשאת סופר אדמין');
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
  if (actor.role === 'viewer') {
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

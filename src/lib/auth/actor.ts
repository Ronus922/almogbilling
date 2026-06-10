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

export async function requireCanManageRole(targetRole: Role): Promise<Actor> {
  const actor = await requireActor();
  if (!canManageRole(actor.role, targetRole)) {
    throw new AuthorizationError('אין הרשאה לנהל תפקיד זה');
  }
  return actor;
}

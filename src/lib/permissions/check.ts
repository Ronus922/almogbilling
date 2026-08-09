import {
  type Action,
  type ModulePermission,
  type Role,
  ROLE_DEFAULTS,
  isElevatedRole,
  SUPER_ADMIN_ONLY,
  MODULES,
} from './constants';

export function hasPermission(
  role: Role,
  permissions: ModulePermission[],
  module: string,
  action: Action,
): boolean {
  if (role === 'super_admin') return true;
  if (role === 'admin') return !SUPER_ADMIN_ONLY.includes(module);

  const p = permissions.find((x) => x.module === module);
  if (!p) return false;
  if (action === 'view') return p.canView;
  if (action === 'edit') return p.canEdit;
  return false;
}

/**
 * Can `actorRole` perform lifecycle management (create / change-role / disable /
 * delete) on a user whose role is `targetRole`?
 *
 *  - super_admin manages everyone. The super_admin-vs-super_admin business rules
 *    (self-protection, last-admin guard, no demoting/disabling another
 *    super_admin) are enforced separately in the route handlers.
 *  - admin manages only manager / viewer. An admin may never create, edit the
 *    role of, disable, or delete another admin or a super_admin.
 */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return !isElevatedRole(targetRole);
  return false;
}

/**
 * Can `actorRole` edit profile fields (full_name, is_active) of a user with `targetRole`?
 */
export function canEditUserProfile(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return !isElevatedRole(targetRole);
  return false;
}

/** Seed matrix for a matrix-managed role; null for roles that bypass the matrix. */
export function getDefaultPermissions(role: Role): ModulePermission[] | null {
  const defaults = ROLE_DEFAULTS[role];
  return defaults ? defaults.map((p) => ({ ...p })) : null;
}

/** Modules the actor cannot view — used by sidebar to filter nav items. */
export function getHiddenModules(role: Role, permissions: ModulePermission[]): string[] {
  return MODULES.filter((m) => !hasPermission(role, permissions, m.key, 'view')).map((m) => m.key);
}

/**
 * Does the actor have access to ANYTHING? Admin tiers always do; every other
 * role only if some permission row grants view or edit. Used solely to route
 * the zero-permissions case to /no-access — never for per-module gating.
 */
export function hasAnyAccess(role: Role, permissions: ModulePermission[]): boolean {
  if (role === 'super_admin' || role === 'admin') return true;
  return permissions.some((p) => p.canView || p.canEdit);
}

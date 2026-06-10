import {
  type Action,
  type ModulePermission,
  type Role,
  DEFAULT_MANAGER,
  DEFAULT_VIEWER,
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
 * Can `actorRole` create / delete / change role of a user with `targetRole`?
 * Per spec: only super_admin may manage user lifecycle (admin can edit profiles
 * of manager/viewer but cannot create/delete or change role).
 */
export function canManageRole(actorRole: Role, _targetRole: Role): boolean {
  return actorRole === 'super_admin';
}

/**
 * Can `actorRole` edit profile fields (full_name, is_active) of a user with `targetRole`?
 */
export function canEditUserProfile(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return targetRole === 'manager' || targetRole === 'viewer';
  return false;
}

export function getDefaultPermissions(role: Role): ModulePermission[] | null {
  if (role === 'manager') return DEFAULT_MANAGER.map((p) => ({ ...p }));
  if (role === 'viewer')  return DEFAULT_VIEWER.map((p) => ({ ...p }));
  return null;
}

/** Modules the actor cannot view — used by sidebar to filter nav items. */
export function getHiddenModules(role: Role, permissions: ModulePermission[]): string[] {
  return MODULES.filter((m) => !hasPermission(role, permissions, m.key, 'view')).map((m) => m.key);
}

import {
  type Action,
  type ModulePermission,
  type Role,
  ASSISTANT_ROLES,
  REPORTER_PHONE_PERMISSION,
  ROLE_DEFAULTS,
  isElevatedRole,
  SUPER_ADMIN_ONLY,
  USER_DELETE_ROLES,
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

/** Seed matrix for a matrix-managed role; null for roles that bypass the matrix. */
export function getDefaultPermissions(role: Role): ModulePermission[] | null {
  const defaults = ROLE_DEFAULTS[role];
  return defaults ? defaults.map((p) => ({ ...p })) : null;
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

/**
 * May this actor use the personal assistant (/api/agent/*, the floating bot)?
 * Two gates, BOTH required:
 *   1. the role is on the staff allowlist (ASSISTANT_ROLES) — a resident, or any
 *      role added later, is denied here no matter what its matrix rows say;
 *   2. the permission gate the assistant always had — the same one as the
 *      debtors screen (dashboard:view OR contacts:view) — so a staff user keeps
 *      exactly the access they have today.
 * One predicate for both layers: requireAssistantAccess() (server) and
 * AgentFab (UI) call this, so they cannot drift apart.
 */
export function canUseAssistant(role: Role, permissions: ModulePermission[]): boolean {
  if (!ASSISTANT_ROLES.includes(role)) return false;
  return (
    hasPermission(role, permissions, 'dashboard', 'view') ||
    hasPermission(role, permissions, 'contacts', 'view')
  );
}

/**
 * May `role` delete a staff user permanently (DELETE /api/users/[id])?
 * The USER_DELETE_ROLES allowlist and nothing else — the matrix is not
 * consulted, so no user_permissions row can ever grant it. Who may be
 * deleted (never yourself, never the last active super admin, never the
 * nominal owner of the WhatsApp instance) is the route's business.
 */
export function canDeleteUsers(role: Role): boolean {
  return USER_DELETE_ROLES.includes(role);
}

/**
 * May this actor see the phone of a resident who reported a fault from the
 * owners portal? The tenants-list permission (REPORTER_PHONE_PERMISSION,
 * contacts:view) — the one that already governs owners' contact details. Used
 * by GET /api/issues/[id] (the only route that ever sends the phone) and by
 * /issues for the panel, so the two cannot drift apart.
 */
export function canSeeReporterPhone(role: Role, permissions: ModulePermission[]): boolean {
  return hasPermission(role, permissions, REPORTER_PHONE_PERMISSION.module, REPORTER_PHONE_PERMISSION.action);
}

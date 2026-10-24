import { hasPermission } from '@/lib/permissions/check';
import { isElevatedRole, type Action, type ModulePermission, type Role } from '@/lib/permissions/constants';
import type { DocType } from './model';

// Who may do what in purchasing — ONE place for all three layers (route guards,
// the page, the screen's buttons). Each document type has its own matrix key
// with a view / edit level per user; super_admin and admin bypass the matrix
// (hasPermission). The module's settings are by ROLE, never a matrix level.

export const PURCHASING_MODULE: Record<DocType, string> = {
  rfq: 'purchasing_requests',
  po: 'purchasing_orders',
};

export const PURCHASING_MODULES: readonly string[] = Object.values(PURCHASING_MODULE);

interface Who { role: Role; permissions: ModulePermission[] }

/** `action` on one document type (view = list and open; edit = create, change, delete, send). */
export function canPurchasing(who: Who, type: DocType, action: Action): boolean {
  return hasPermission(who.role, who.permissions, PURCHASING_MODULE[type], action);
}

/** Any purchasing permission at that level — the menu group, the counter, the banner. */
export function canAnyPurchasing(who: Who, action: Action = 'view'): boolean {
  return (['rfq', 'po'] as const).some((t) => canPurchasing(who, t, action));
}

/** The letterhead and the numbering: admin and up (decision 24/10/2026). */
export function canPurchasingSettings(role: Role): boolean {
  return isElevatedRole(role);
}

import { NextResponse } from 'next/server';
import { requireAdmin, requireAnyPermission, requirePermission, type Actor } from './actor';
import { AuthorizationError } from './errors';
import { canPurchasing, PURCHASING_MODULE, PURCHASING_MODULES } from '@/lib/purchasing/access';
import type { Action } from '@/lib/permissions/constants';
import type { DocType } from '@/lib/purchasing/model';

// Route guards of the purchasing module. Routes that know the document type up
// front use requirePurchasingType; routes that only learn it after loading the
// document pass the coarse requirePurchasingAny first, then denyPurchasingType
// on the loaded type (so a request-only user is refused on an order, and the
// other way round). The supplier's public link never goes through here.

export function requirePurchasingAny(action: Action): Promise<Actor> {
  return requireAnyPermission(PURCHASING_MODULES.map((module) => ({ module, action })));
}

export function requirePurchasingType(type: DocType, action: Action): Promise<Actor> {
  return requirePermission(PURCHASING_MODULE[type], action);
}

/** The usual 403 response when the actor lacks `action` on `type`, else null. */
export function denyPurchasingType(actor: Actor, type: DocType, action: Action): NextResponse | null {
  if (canPurchasing(actor, type, action)) return null;
  return NextResponse.json({ error: new AuthorizationError('אין הרשאה לבצע את הפעולה').message }, { status: 403 });
}

/** The letterhead / numbering settings: admin and up. */
export function requirePurchasingSettings(): Promise<Actor> {
  return requireAdmin();
}

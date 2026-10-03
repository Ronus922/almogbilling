import type { OwnerPhoneSource } from '@/lib/types/portal';
import { PORTAL_ROLE_LABEL, type PortalRole } from '@/lib/portal/identity';
import { formatPhoneDisplay } from '@/lib/phone';
import { e164ToLocal } from '@/lib/portal/phone';

// Display words for the portal roster's provenance and detach reasons —
// shared by the apartment card's "טלפון ← דירות בפורטל" and /admin/portal-blocked.

/** Which record carries the phone, in the role it gives it (migrations
 *  20261003095149 + 20261003161745): the card's own field, or an extra person. */
export function rosterSourceLabel(source: OwnerPhoneSource | null, role: PortalRole): string {
  if (!source) return 'אין רשומה';
  if (source === 'contacts') {
    return role === 'owner' ? 'רשומת הבעלים' : role === 'tenant' ? 'רשומת השוכר' : 'רשומת המפעיל';
  }
  return `איש קשר — ${PORTAL_ROLE_LABEL[role]}`;
}

/** Why a row is off. A row that is off with no detach = no record holds it. */
export function ownerPhoneOffLabel(detachReason: string | null): string {
  switch (detachReason) {
    case 'admin': return 'נותק ידנית';
    case 'audit_2026_10': return 'נותק בניקוי 03/10/2026';
    case 'owner_replaced': return 'הבעלים הוחלף (אישור בלינק)';
    case 'bllink_removed': return 'נותק — לא מופיע עוד בבלינק (אישור)';
    case null: return 'אין רשומה שמחזיקה את הטלפון';
    default: return 'נותק';
  }
}

/** '+972525460546' → '052-546-0546'; a foreign number stays E.164. */
export function rosterPhoneDisplay(e164: string): string {
  return e164.startsWith('+972') ? (formatPhoneDisplay(e164ToLocal(e164)) ?? e164) : e164;
}

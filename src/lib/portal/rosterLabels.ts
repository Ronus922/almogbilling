import type { OwnerPhoneSource } from '@/lib/types/portal';
import { formatPhoneDisplay } from '@/lib/phone';
import { e164ToLocal } from '@/lib/portal/phone';

// Display words for the portal roster's provenance and detach reasons —
// shared by the apartment card's "טלפון ← דירות בפורטל" and /admin/portal-blocked.

/** Which owner record carries the phone (migration 20261003095149). */
export const OWNER_PHONE_SOURCE_LABEL: Record<OwnerPhoneSource, string> = {
  contacts: 'רשומת הבעלים',
  contact_people: 'איש קשר — בעלים',
};

/** Why a row is off. A row that is off with no detach = no record holds it. */
export function ownerPhoneOffLabel(detachReason: string | null): string {
  switch (detachReason) {
    case 'admin': return 'נותק ידנית';
    case 'audit_2026_10': return 'נותק בניקוי 03/10/2026';
    case 'owner_replaced': return 'הבעלים הוחלף (אישור בלינק)';
    case null: return 'אין רשומה שמחזיקה את הטלפון';
    default: return 'נותק';
  }
}

/** '+972525460546' → '052-546-0546'; a foreign number stays E.164. */
export function rosterPhoneDisplay(e164: string): string {
  return e164.startsWith('+972') ? (formatPhoneDisplay(e164ToLocal(e164)) ?? e164) : e164;
}

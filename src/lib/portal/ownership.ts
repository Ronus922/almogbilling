// Names on the portal roster, and the notice a BLOCKED phone sees.
//
// Whether a phone is one person — and so whether it is blocked — is decided
// in ONE place, lib/portal/identity.ts (03/10/2026, "זהות אחידה"): a phone
// whose apartments are recorded under different names (after whitespace
// normalisation), or that carries a nameless record next to other apartments,
// sees no financial data unless an identity was approved for it.

/** "  דנה   לוי " → "דנה לוי"; empty → null. */
export function normalizeOwnerName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  return n === '' ? null : n;
}

/** What a blocked phone sees instead of any figure (and the 403 of the API). */
export const PORTAL_ACCOUNT_REVIEW_MESSAGE = 'אנחנו מעדכנים את פרטי החשבון שלך. לפרטים פנה לחברת הניהול.';

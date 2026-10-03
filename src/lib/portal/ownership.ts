// Containment (03/10/2026): a phone whose apartments belong to DIFFERENT people
// sees no financial data in the owners portal.
//
// Why: apartment_owner_phones linked phones to apartments that are not theirs
// (an owner's phone sat on another owner's apartment, so "החשבון שלי" showed a
// stranger's debt). Until the roster is rebuilt from explicit owner records,
// the portal refuses to trust a phone whose apartments do not all carry the
// same owner.
//
// The rule, on the phone's ACTIVE roster rows:
//   • one apartment → trusted (nothing to compare);
//   • several apartments → trusted only when every row carries a name and all
//     the names are equal after whitespace normalisation. A row with no name
//     cannot show it is the same person, so it does not pass either.
//
// Isomorphic and pure: the server layer applies it to the roster rows, the
// tests apply it directly.

export interface RosterOwnerRow {
  apartment_number: string;
  owner_name: string | null;
}

/** "  דנה   לוי " → "דנה לוי"; empty → null. */
export function normalizeOwnerName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  return n === '' ? null : n;
}

/** True when the rows (one phone's active roster rows) span several apartments
 *  that cannot be shown to belong to one person — see the rule above. */
export function hasMixedOwners(rows: ReadonlyArray<RosterOwnerRow>): boolean {
  const apartments = new Set(rows.map((r) => r.apartment_number));
  if (apartments.size <= 1) return false;
  const names = rows.map((r) => normalizeOwnerName(r.owner_name));
  if (names.some((n) => n === null)) return true;
  return new Set(names).size > 1;
}

/** What such a phone sees instead of any figure (and the 403 of the API). */
export const PORTAL_ACCOUNT_REVIEW_MESSAGE = 'אנחנו מעדכנים את פרטי החשבון שלך. לפרטים פנה לחברת הניהול.';

/** The reporter name a fault from such a phone is recorded under. The phone
 *  itself stays in reporter_phone — served only to staff with contacts:view
 *  (decision 03/10/2026), so it is never written into the name, which every
 *  issues:view user receives. */
export const PORTAL_UNIDENTIFIED_REPORTER = 'לא מזוהה';

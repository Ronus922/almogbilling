// Phone utilities — single source of truth for picking + formatting display phones.
//
// Source schema in this project:
//   - phone_owner   (string | null)  — owner's phone (also gets manual-override edits)
//   - phone_tenant  (string | null)  — tenant's phone
//
// (The Base44 reference also had phone_primary; we don't have it as a separate
// column. Manual selection lives on phone_owner + phones_manual_override.)

interface PhoneSource {
  phone_owner: string | null;
  phone_tenant: string | null;
}

/**
 * Normalizes a raw phone string into a display format.
 *
 * Steps:
 *   1. Split on `/`, `,`, whitespace — take the first token (handles
 *      Excel cells like "0541234567 / 0521234567").
 *   2. Strip every non-digit.
 *   3. Country-code normalize: 972 → 0.
 *   4. Add a leading 0 to 9-digit numbers that start with 2–9
 *      (Israeli mobile / landline written without the trunk 0).
 *   5. Reject `< 9` digits or all-zero strings.
 *   6. Format 10 digits as `0XX-XXX-XXXX`. Otherwise return raw digits.
 *
 * Returns `null` for invalid input.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = String(raw).split(/[\/,\s]+/)[0]?.trim();
  if (!first) return null;
  let digits = first.replace(/\D+/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  if (digits.length === 9 && /^[2-9]/.test(digits)) digits = '0' + digits;
  if (digits.length < 9 || /^0+$/.test(digits)) return null;
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

/**
 * Picks the primary raw phone for table display.
 *
 * Priority:
 *   1. phone_owner  — if the value passes formatPhoneDisplay validation
 *   2. phone_tenant — fallback if owner is missing/invalid
 *   3. null         — caller renders "—"
 *
 * Validity is delegated to formatPhoneDisplay so that "0000000000" or
 * other junk in phone_owner correctly falls through to phone_tenant.
 */
export function getPrimaryPhone({ phone_owner, phone_tenant }: PhoneSource): string | null {
  if (formatPhoneDisplay(phone_owner)) return phone_owner;
  if (formatPhoneDisplay(phone_tenant)) return phone_tenant;
  return null;
}

/** Returns digits-only string suitable for `tel:` href, or null. */
export function phoneTelHref(raw: string | null | undefined): string | null {
  const display = formatPhoneDisplay(raw);
  if (!display) return null;
  return display.replace(/\D+/g, '');
}

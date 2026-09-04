// Validation for Settings → "עורך דין" (app_settings key 'legal_contact').
// Pure — shared by the API route (server) and the side panel (client), so
// both sides reject the same input with the same Hebrew message.

export interface LegalContact {
  email: string;
  name: string;
}

export const EMPTY_LEGAL_CONTACT: LegalContact = { email: '', name: '' };
export const LEGAL_CONTACT_NAME_MAX = 80;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LegalContactErrors {
  email?: string;
  name?: string;
}

export type NormalizedLegalContact =
  | { ok: true; value: LegalContact }
  | { ok: false; errors: LegalContactErrors };

/**
 * Trims both fields. Each may be empty — a cleared contact is a valid state
 * (nothing is sent to the lawyer). A non-empty email must be well-formed and
 * is stored lower-cased so recipient de-duplication is case-insensitive.
 */
export function normalizeLegalContact(input: { email?: unknown; name?: unknown }): NormalizedLegalContact {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';

  const errors: LegalContactErrors = {};
  if (email && !EMAIL_RE.test(email)) errors.email = 'כתובת אימייל לא תקינה';
  if (name.length > LEGAL_CONTACT_NAME_MAX) errors.name = `השם יכול להכיל עד ${LEGAL_CONTACT_NAME_MAX} תווים`;
  if (errors.email || errors.name) return { ok: false, errors };

  return { ok: true, value: { email, name } };
}

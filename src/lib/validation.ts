// Source of truth for input validation. Mirror error messages in DESIGN.md
// (Section 7) so frontend + backend use the same wording.

export function normalizePhone(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw).replace(/\D+/g, '');
}

export type PhoneType = 'mobile' | 'landline' | 'international';

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string;
  type: PhoneType | null;
  error?: string;
}

/**
 * Rich phone validator (Israeli + international 972).
 *
 *  - Mobile:        10 digits, /^05[0-9]{8}$/                     → '0541234567'
 *  - Landline:      9–10 digits, /^0[2-9][0-9]{7,8}$/             → '031234567' / '0721234567'
 *  - International: '+972' + 9 digits, /^\+972[0-9]{9}$/          → '+972541234567'
 */
export function validatePhone(input: string | null | undefined): PhoneValidationResult {
  if (input == null || !String(input).trim()) {
    return { valid: false, normalized: '', type: null, error: 'שדה טלפון ריק' };
  }
  const trimmed = String(input).trim();

  if (trimmed.startsWith('+')) {
    const intl = trimmed.replace(/[^\d+]/g, '');
    if (/^\+972[0-9]{9}$/.test(intl)) {
      return { valid: true, normalized: intl, type: 'international' };
    }
    return { valid: false, normalized: intl, type: null, error: 'מספר בינלאומי לא תקין' };
  }

  const normalized = normalizePhone(trimmed);

  if (/^05[0-9]{8}$/.test(normalized)) {
    return { valid: true, normalized, type: 'mobile' };
  }
  if (/^0[2-9][0-9]{7,8}$/.test(normalized)) {
    return { valid: true, normalized, type: 'landline' };
  }

  if (normalized.length < 9) {
    return { valid: false, normalized, type: null, error: 'מספר הטלפון קצר מדי' };
  }
  if (normalized.length > 10) {
    return { valid: false, normalized, type: null, error: 'מספר הטלפון ארוך מדי' };
  }
  if (!normalized.startsWith('0')) {
    return { valid: false, normalized, type: null, error: 'מספר טלפון חייב להתחיל ב-0' };
  }
  return { valid: false, normalized, type: null, error: 'מספר טלפון לא תקין' };
}

/** Thin wrapper kept for callers that only need the boolean. */
export function isValidPhone(raw: string | null | undefined): boolean {
  return validatePhone(raw).valid;
}

export function isFutureDate(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

export function isPastDate(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

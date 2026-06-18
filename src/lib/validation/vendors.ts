// Shared validation + coercion for the Vendors module — used by POST /api/vendors
// and PATCH /api/vendors/[id] (single source of truth), plus the category form
// and the category-delete guard.
//
// Pure (no DB, no server-only): cleanPhoneField is a pure helper, so this whole
// module is unit-testable.

import { cleanPhoneField } from '@/lib/whatsapp';
import type { VendorWritableFields } from '@/lib/types/vendors';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CATEGORY_NAME_MAX = 60;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export type VendorValidation =
  | { ok: true; fields: VendorWritableFields }
  | { ok: false; error: string };

/**
 * Coerce arbitrary JSON into a validated VendorWritableFields.
 * Error codes: name_required, invalid_category, invalid_phone, invalid_email.
 *   - name is required.
 *   - category_id must be a uuid or null (FK existence enforced by the DB).
 *   - phone (when present) is cleaned to ONE canonical local number
 *     (project phone-field policy) via cleanPhoneField — reject unparseable.
 *   - email (when present) is format-validated.
 */
export function coerceAndValidateVendor(body: Record<string, unknown>): VendorValidation {
  const name = str(body.name);
  if (!name) return { ok: false, error: 'name_required' };

  const category_id: string | null = str(body.category_id) || null;
  if (category_id && !UUID_RE.test(category_id)) {
    return { ok: false, error: 'invalid_category' };
  }

  const phoneRaw = str(body.phone);
  let phone = '';
  if (phoneRaw) {
    const cleaned = cleanPhoneField(phoneRaw);
    if (!cleaned) return { ok: false, error: 'invalid_phone' };
    phone = cleaned;
  }

  const email = str(body.email);
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  return {
    ok: true,
    fields: {
      name,
      category_id,
      contact_person: str(body.contact_person),
      phone,
      email,
      address: str(body.address),
      notes: str(body.notes),
    },
  };
}

// ─── Category form ──────────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export function validateVendorCategoryForm(input: {
  name?: unknown;
}): ValidationResult<{ name: string }> {
  const errors: Record<string, string> = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'שם הקטגוריה הוא שדה חובה';
  else if (name.length > CATEGORY_NAME_MAX) {
    errors.name = `שם הקטגוריה ארוך מדי (מקסימום ${CATEGORY_NAME_MAX} תווים)`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name } };
}

/**
 * A category may be hard-deleted only when no ACTIVE vendor references it.
 * Single source of truth for the delete guard — used by the route and tested.
 */
export function canDeleteVendorCategory(linkedCount: number): boolean {
  return linkedCount <= 0;
}

// Shared validation + coercion for the Suppliers module — used by both
// POST /api/suppliers and PATCH /api/suppliers/[id] (single source of truth).
//
// Capabilities:
//   - phone/mobile are cleaned to ONE canonical local number via cleanPhoneField
//     (project phone-field policy) — not just validity-checked.
//   - email is format-validated when present.
//   - category_id is accepted (uuid or null) and category management is guarded.
//
// Pure (no DB, no server-only): cleanPhoneField is a pure helper.

import { cleanPhoneField } from '@/lib/whatsapp';
import type {
  SupplierStatus,
  SupplierPaymentTerms,
  SupplierWritableFields,
} from '@/lib/types/suppliers';

const STATUSES: readonly SupplierStatus[] = ['active', 'inactive', 'archived'];
const PAYMENT_TERMS: readonly SupplierPaymentTerms[] = [
  'immediate', 'net_15', 'net_30', 'net_45', 'net_60', 'net_90', 'other',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CATEGORY_NAME_MAX = 60;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export type SupplierValidation =
  | { ok: true; fields: SupplierWritableFields }
  | { ok: false; error: string };

/**
 * Coerce arbitrary JSON into a fully-defaulted, validated SupplierWritableFields.
 * Error codes mirror the existing route contract (display_name_required,
 * invalid_phone) plus the new invalid_email / invalid_category.
 */
export function coerceAndValidateSupplier(body: Record<string, unknown>): SupplierValidation {
  const display_name = str(body.display_name);
  if (!display_name) return { ok: false, error: 'display_name_required' };

  const statusRaw = str(body.status);
  const status: SupplierStatus = STATUSES.includes(statusRaw as SupplierStatus)
    ? (statusRaw as SupplierStatus)
    : 'active';

  const termsRaw = str(body.payment_terms);
  const payment_terms: SupplierPaymentTerms = PAYMENT_TERMS.includes(
    termsRaw as SupplierPaymentTerms,
  )
    ? (termsRaw as SupplierPaymentTerms)
    : 'immediate';

  const supplier_type = str(body.supplier_type) || 'general';

  // Optional dynamic category — uuid or null (FK existence enforced by the DB).
  const category_id: string | null = str(body.category_id) || null;
  if (category_id && !UUID_RE.test(category_id)) {
    return { ok: false, error: 'invalid_category' };
  }

  // phone / mobile — cleaned to one canonical local number; reject unparseable.
  const phoneRaw = str(body.phone);
  let phone = '';
  if (phoneRaw) {
    const cleaned = cleanPhoneField(phoneRaw);
    if (!cleaned) return { ok: false, error: 'invalid_phone' };
    phone = cleaned;
  }
  const mobileRaw = str(body.mobile);
  let mobile = '';
  if (mobileRaw) {
    const cleaned = cleanPhoneField(mobileRaw);
    if (!cleaned) return { ok: false, error: 'invalid_phone' };
    mobile = cleaned;
  }

  const email = str(body.email);
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

  let rating: number | null = null;
  if (typeof body.rating === 'number' && Number.isFinite(body.rating)) {
    rating = body.rating;
  }

  return {
    ok: true,
    fields: {
      display_name,
      company_name: str(body.company_name),
      contact_person: str(body.contact_person),
      supplier_type,
      category_id,
      status,
      phone,
      mobile,
      email,
      website: str(body.website),
      address: str(body.address),
      city: str(body.city),
      tax_id: str(body.tax_id),
      bank_name: str(body.bank_name),
      bank_branch: str(body.bank_branch),
      bank_account: str(body.bank_account),
      payment_terms,
      notes: str(body.notes),
      internal_notes: str(body.internal_notes),
      rating,
    },
  };
}

// ─── Category form ────────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export function validateSupplierCategoryForm(input: {
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
 * A category may be hard-deleted only when no live supplier references it.
 * Single source of truth for the delete guard — used by the route and tested.
 */
export function canDeleteSupplierCategory(linkedCount: number): boolean {
  return linkedCount <= 0;
}

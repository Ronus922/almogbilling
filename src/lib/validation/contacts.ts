// Shared validation + coercion for the Contacts module — used by both
// POST /api/contacts and PATCH /api/contacts/[id] (single source of truth).
//
// - Partial by design: only keys present in the body appear in the result, so
//   a PATCH never nulls a field the client didn't send.
// - Phone fields are cleaned to ONE canonical local number via cleanPhoneField
//   (project phone-field policy) — not just validity-checked.
// - apartment_number is required on create and ignored on update (immutable).
//
// Pure (no DB, no server-only): safe to import anywhere.

import { cleanPhoneField } from '@/lib/whatsapp';
import type {
  ContactPersonInput,
  ContactPersonRole,
  ContactResidentType,
  ContactWritableFields,
  WhatsappProfileSyncStatus,
} from '@/lib/types/contacts';

const RESIDENT_TYPES: readonly ContactResidentType[] = ['owner', 'tenant', 'operator'];
const SYNC_STATUSES: readonly WhatsappProfileSyncStatus[] = [
  'pending', 'synced', 'no_avatar', 'unavailable', 'failed',
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ContactValidation =
  | { ok: true; fields: Partial<ContactWritableFields> }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** Trim a string; '' and non-strings become null. */
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Lenient boolean coercion (accepts true/false, 'true'/'false', 1/0). */
function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return null;
}

function toStringTags(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Coerce a non-negative money/measure value. '' / null / undefined → null.
 * Rejects anything unparseable or negative (returns `{ ok: false }`).
 */
function toNonNegativeNumber(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** Validate an optional ISO timestamp string (sync-managed fields). */
function toIsoOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return { ok: false };
  return { ok: true, value: v };
}

/**
 * Coerce arbitrary JSON into a validated, partial ContactWritableFields.
 * mode='create' requires apartment_number; mode='update' ignores it (immutable).
 */
export function coerceContactInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): ContactValidation {
  const fields: Partial<ContactWritableFields> = {};

  // apartment_number — required on create, ignored on update.
  if (mode === 'create') {
    const apt = strOrNull(body.apartment_number);
    if (!apt) return { ok: false, error: 'apartment_number_required' };
    fields.apartment_number = apt;
  }

  // Plain nullable text fields.
  if (has(body, 'owner_name')) fields.owner_name = strOrNull(body.owner_name);
  if (has(body, 'tenant_name')) fields.tenant_name = strOrNull(body.tenant_name);
  if (has(body, 'address')) fields.address = strOrNull(body.address);
  if (has(body, 'notes')) fields.notes = strOrNull(body.notes);
  if (has(body, 'whatsapp_profile_image_url')) {
    fields.whatsapp_profile_image_url = strOrNull(body.whatsapp_profile_image_url);
  }
  if (has(body, 'whatsapp_profile_sync_error')) {
    fields.whatsapp_profile_sync_error = strOrNull(body.whatsapp_profile_sync_error);
  }

  // Phone fields — cleaned to one canonical local number; reject unparseable.
  for (const key of ['owner_phone', 'tenant_phone'] as const) {
    if (!has(body, key)) continue;
    const raw = strOrNull(body[key]);
    if (raw === null) {
      fields[key] = null;
      continue;
    }
    const cleaned = cleanPhoneField(raw);
    if (!cleaned) return { ok: false, error: 'invalid_phone' };
    fields[key] = cleaned;
  }

  // Email fields — format-validated when present.
  for (const key of ['owner_email', 'tenant_email'] as const) {
    if (!has(body, key)) continue;
    const raw = strOrNull(body[key]);
    if (raw === null) {
      fields[key] = null;
      continue;
    }
    if (!EMAIL_RE.test(raw)) return { ok: false, error: 'invalid_email' };
    fields[key] = raw;
  }

  // Apartment measures — non-negative numbers or null.
  for (const key of ['apartment_size_sqm', 'management_fee'] as const) {
    if (!has(body, key)) continue;
    const n = toNonNegativeNumber(body[key]);
    if (!n.ok) return { ok: false, error: `invalid_${key}` };
    fields[key] = n.value;
  }

  // resident_type — enum.
  if (has(body, 'resident_type')) {
    const rt = strOrNull(body.resident_type);
    if (!rt || !RESIDENT_TYPES.includes(rt as ContactResidentType)) {
      return { ok: false, error: 'invalid_resident_type' };
    }
    fields.resident_type = rt as ContactResidentType;
  }

  // operator_id — uuid or null.
  if (has(body, 'operator_id')) {
    const op = strOrNull(body.operator_id);
    if (op && !UUID_RE.test(op)) return { ok: false, error: 'invalid_operator_id' };
    fields.operator_id = op;
  }

  // Primary-contact booleans.
  for (const key of [
    'owner_is_primary_contact',
    'tenant_is_primary_contact',
    'operator_is_primary_contact',
  ] as const) {
    if (!has(body, key)) continue;
    const b = toBool(body[key]);
    if (b === null) return { ok: false, error: 'invalid_boolean' };
    fields[key] = b;
  }

  // tags — array of non-empty strings, deduped.
  if (has(body, 'tags')) {
    const tags = toStringTags(body.tags);
    if (tags === null) return { ok: false, error: 'invalid_tags' };
    fields.tags = tags;
  }

  // whatsapp_profile_sync_status — enum or null.
  if (has(body, 'whatsapp_profile_sync_status')) {
    const st = strOrNull(body.whatsapp_profile_sync_status);
    if (st && !SYNC_STATUSES.includes(st as WhatsappProfileSyncStatus)) {
      return { ok: false, error: 'invalid_sync_status' };
    }
    fields.whatsapp_profile_sync_status = st as WhatsappProfileSyncStatus | null;
  }

  // Sync-managed timestamps — ISO string or null.
  for (const key of [
    'whatsapp_profile_last_synced_at',
    'last_whatsapp_sent_at',
    'last_synced_at',
  ] as const) {
    if (!has(body, key)) continue;
    const r = toIsoOrNull(body[key]);
    if (!r.ok) return { ok: false, error: 'invalid_timestamp' };
    fields[key] = r.value;
  }

  return { ok: true, fields };
}

export type ContactPeopleValidation =
  | { ok: true; people: ContactPersonInput[] }
  | { ok: false; error: string };

const PERSON_ROLES: readonly ContactPersonRole[] = ['owner', 'tenant'];

/**
 * Coerce the apartment card's extra owners/tenants (`body.people`) into a
 * validated list. The client always sends the COMPLETE list, so the caller
 * replaces the stored rows with it wholesale.
 *
 * - Phones go through cleanPhoneField (project phone-field policy), emails
 *   through the same format check as the built-in owner/tenant fields.
 * - A fully blank row (no name, no phone, no email) is dropped silently — it is
 *   an "add" the user never filled in, not an error.
 */
export function coerceContactPeople(value: unknown): ContactPeopleValidation {
  if (!Array.isArray(value)) return { ok: false, error: 'invalid_people' };
  if (value.length > 50) return { ok: false, error: 'too_many_people' };

  const people: ContactPersonInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_people' };
    const rec = raw as Record<string, unknown>;

    const role = strOrNull(rec.role);
    if (!role || !PERSON_ROLES.includes(role as ContactPersonRole)) {
      return { ok: false, error: 'invalid_person_role' };
    }

    const name = strOrNull(rec.name);
    const rawPhone = strOrNull(rec.phone);
    const email = strOrNull(rec.email);
    if (name === null && rawPhone === null && email === null) continue; // untouched row

    let phone: string | null = null;
    if (rawPhone !== null) {
      phone = cleanPhoneField(rawPhone);
      if (!phone) return { ok: false, error: 'invalid_phone' };
    }
    if (email !== null && !EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };

    const isPrimary = has(rec, 'is_primary_contact') ? toBool(rec.is_primary_contact) : true;
    if (isPrimary === null) return { ok: false, error: 'invalid_boolean' };

    people.push({
      role: role as ContactPersonRole,
      name,
      phone,
      email,
      is_primary_contact: isPrimary,
    });
  }
  return { ok: true, people };
}

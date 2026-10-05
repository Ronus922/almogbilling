// Shared validation + coercion for the Reminders module — used by both
// POST /api/user-reminders and PATCH /api/user-reminders/[id].
//
// - Partial by design: only keys present in the body appear in the result, so
//   a PATCH never nulls a field the client didn't send.
// - title + remind_at are required on create; on update they're only validated
//   if present.
//
// Pure (no DB, no server-only): safe to import anywhere.

import type {
  UserReminderStatus,
  UserReminderWritableFields,
} from '@/lib/types/userReminders';
import { REMINDER_ATTACHMENT_LIMITS } from '@/lib/constants/reminderAttachments';

/** The panel's "0 / 1000" counter — also a CHECK on user_reminders.description. */
export const REMINDER_DESCRIPTION_MAX = 1000;

const STATUSES: readonly UserReminderStatus[] = ['pending', 'done', 'dismissed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UserReminderValidation =
  | { ok: true; fields: Partial<UserReminderWritableFields> }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function coerceUserReminderInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): UserReminderValidation {
  const fields: Partial<UserReminderWritableFields> = {};

  // title — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'title')) {
    const title = strOrNull(body.title);
    if (!title) return { ok: false, error: 'title_required' };
    if (title.length > 300) return { ok: false, error: 'title_too_long' };
    fields.title = title;
  }

  // description — optional free text; blank → NULL. Inner line breaks are kept.
  if (has(body, 'description')) {
    if (body.description !== null && typeof body.description !== 'string') {
      return { ok: false, error: 'invalid_description' };
    }
    const d = strOrNull(body.description);
    if (d && d.length > REMINDER_DESCRIPTION_MAX) return { ok: false, error: 'description_too_long' };
    fields.description = d;
  }

  // remind_at — required on create; full ISO timestamptz.
  if (mode === 'create' || has(body, 'remind_at')) {
    const remindAt = strOrNull(body.remind_at);
    if (!remindAt) return { ok: false, error: 'remind_at_required' };
    if (Number.isNaN(Date.parse(remindAt))) return { ok: false, error: 'invalid_remind_at' };
    fields.remind_at = remindAt;
  }

  if (has(body, 'status')) {
    const s = strOrNull(body.status);
    if (!s || !STATUSES.includes(s as UserReminderStatus)) {
      return { ok: false, error: 'invalid_status' };
    }
    fields.status = s as UserReminderStatus;
  }

  // entity_type / entity_id — polymorphic, open. Both nullable.
  if (has(body, 'entity_type')) {
    const et = strOrNull(body.entity_type);
    if (et && et.length > 100) return { ok: false, error: 'entity_type_too_long' };
    fields.entity_type = et;
  }
  if (has(body, 'entity_id')) {
    const eid = strOrNull(body.entity_id);
    if (eid && eid.length > 255) return { ok: false, error: 'entity_id_too_long' };
    fields.entity_id = eid;
  }

  if (has(body, 'assigned_to')) {
    const id = strOrNull(body.assigned_to);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: 'invalid_assigned_to' };
    fields.assigned_to = id;
  }

  // category_id — optional FK to reminder_categories, nullable (uncategorized).
  if (has(body, 'category_id')) {
    const id = strOrNull(body.category_id);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: 'invalid_category_id' };
    fields.category_id = id;
  }

  return { ok: true, fields };
}

export type AttachmentIdsValidation =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * attachment_ids — staged files (user_reminder_attachments) to link to the
 * reminder on this save. Optional: absent = none (so a status-only PATCH from
 * the list keeps working). Distinct UUIDs, at most one reminder's worth.
 */
export function coerceAttachmentIds(body: Record<string, unknown>): AttachmentIdsValidation {
  if (!has(body, 'attachment_ids') || body.attachment_ids == null) return { ok: true, ids: [] };
  const raw = body.attachment_ids;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    return { ok: false, error: 'invalid_attachment_ids' };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > REMINDER_ATTACHMENT_LIMITS.maxFiles) return { ok: false, error: 'too_many_attachments' };
  return { ok: true, ids };
}

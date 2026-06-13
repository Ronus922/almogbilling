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

  return { ok: true, fields };
}

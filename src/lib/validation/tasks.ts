// Shared validation + coercion for the Tasks module — used by both
// POST /api/tasks and PATCH /api/tasks/[id] (single source of truth).
//
// - Partial by design: only keys present in the body appear in the result, so
//   a PATCH never nulls a field the client didn't send.
// - title is required on create, ignored-as-required on update (only validated
//   if present).
//
// Pure (no DB, no server-only): safe to import anywhere.

import type {
  ReminderChannel,
  RelatedEntityType,
  TaskPriority,
  TaskStatus,
  TaskWritableFields,
} from '@/lib/types/tasks';

const STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const CHANNELS: readonly ReminderChannel[] = ['in_app', 'email', 'both'];
const RELATED_ENTITY_TYPES: readonly RelatedEntityType[] = [
  'debtor',
  'building',
  'supplier',
  'contact',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export type TaskValidation =
  | { ok: true; fields: Partial<TaskWritableFields> }
  | { ok: false; error: string };

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function coerceTaskInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): TaskValidation {
  const fields: Partial<TaskWritableFields> = {};

  // title — required on create; if present on update must be non-empty.
  if (mode === 'create' || has(body, 'title')) {
    const title = strOrNull(body.title);
    if (!title) return { ok: false, error: 'title_required' };
    if (title.length > 300) return { ok: false, error: 'title_too_long' };
    fields.title = title;
  }

  if (has(body, 'description')) {
    const d = strOrNull(body.description);
    if (d && d.length > 20000) return { ok: false, error: 'description_too_long' };
    fields.description = d;
  }
  if (has(body, 'apartment_number')) {
    const a = strOrNull(body.apartment_number);
    if (a && a.length > 50) return { ok: false, error: 'apartment_number_too_long' };
    fields.apartment_number = a;
  }

  if (has(body, 'status')) {
    const s = strOrNull(body.status);
    if (!s || !STATUSES.includes(s as TaskStatus)) {
      return { ok: false, error: 'invalid_status' };
    }
    fields.status = s as TaskStatus;
  }

  if (has(body, 'priority')) {
    const p = strOrNull(body.priority);
    if (!p || !PRIORITIES.includes(p as TaskPriority)) {
      return { ok: false, error: 'invalid_priority' };
    }
    fields.priority = p as TaskPriority;
  }

  if (has(body, 'due_date')) {
    const d = strOrNull(body.due_date);
    if (d !== null && !DATE_RE.test(d)) return { ok: false, error: 'invalid_due_date' };
    fields.due_date = d;
  }

  if (has(body, 'due_time')) {
    const t = strOrNull(body.due_time);
    if (t !== null && !TIME_RE.test(t)) return { ok: false, error: 'invalid_due_time' };
    fields.due_time = t;
  }

  for (const key of ['assigned_to_user_id', 'debtor_id', 'related_entity_id'] as const) {
    if (!has(body, key)) continue;
    const id = strOrNull(body[key]);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: `invalid_${key}` };
    fields[key] = id;
  }

  if (has(body, 'related_entity_type')) {
    const ret = strOrNull(body.related_entity_type);
    if (ret !== null && !RELATED_ENTITY_TYPES.includes(ret as RelatedEntityType)) {
      return { ok: false, error: 'invalid_related_entity_type' };
    }
    fields.related_entity_type = ret as RelatedEntityType | null;
  }

  return { ok: true, fields };
}

// ── Reminders embedded in the task body ──────────────────────────────────────
export interface ReminderInput {
  remind_at: string; // ISO timestamptz
  channel: ReminderChannel;
}

export type RemindersValidation =
  | { ok: true; reminders: ReminderInput[] }
  | { ok: false; error: string };

/**
 * Coerce body.reminders (optional array of {remind_at, channel}) into a
 * validated list. Absent → null (caller leaves reminders untouched). Present →
 * full replacement set.
 */
export function coerceReminders(body: Record<string, unknown>): RemindersValidation | null {
  if (!has(body, 'reminders')) return null;
  const raw = body.reminders;
  if (raw === null) return { ok: true, reminders: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_reminders' };
  if (raw.length > 50) return { ok: false, error: 'too_many_reminders' };

  const out: ReminderInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_reminder_item' };
    const rec = item as Record<string, unknown>;
    const remindAt = strOrNull(rec.remind_at);
    if (!remindAt || Number.isNaN(Date.parse(remindAt))) {
      return { ok: false, error: 'invalid_reminder_time' };
    }
    const ch = strOrNull(rec.channel) ?? 'both';
    if (!CHANNELS.includes(ch as ReminderChannel)) {
      return { ok: false, error: 'invalid_reminder_channel' };
    }
    out.push({ remind_at: remindAt, channel: ch as ReminderChannel });
  }
  return { ok: true, reminders: out };
}

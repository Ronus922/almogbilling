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
import type { TargetType } from '@/lib/types/targets';
import { coerceChannels } from '@/lib/notify/channels';
import type {
  RecurrenceRule,
  RecurrenceFrequency,
  RecurrenceEndType,
} from '@/lib/recurrence/engine';

const TARGET_TYPES: readonly TargetType[] = ['room', 'area'];

const STATUSES: readonly TaskStatus[] = ['open', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: readonly TaskPriority[] = ['normal', 'high', 'urgent'];
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

  for (const key of ['debtor_id', 'related_entity_id'] as const) {
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

  // Optional target (יעד): target_type ∈ {room, area} + target_id uuid; both
  // nullable. FK existence not enforced (target_id points at two tables).
  if (has(body, 'target_type')) {
    const tt = strOrNull(body.target_type);
    if (tt !== null && !TARGET_TYPES.includes(tt as TargetType)) {
      return { ok: false, error: 'invalid_target_type' };
    }
    fields.target_type = tt as TargetType | null;
  }
  if (has(body, 'target_id')) {
    const id = strOrNull(body.target_id);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: 'invalid_target_id' };
    fields.target_id = id;
  }

  // Assignees (users + suppliers) are validated separately via coerceAssignees
  // and written to the entity_assignees junction — no longer scalar fields here.
  return { ok: true, fields };
}

// ── Reminders embedded in the task body ──────────────────────────────────────
export interface ReminderInput {
  remind_at: string; // ISO timestamptz
  channels: ReminderChannel[]; // non-empty subset of in_app/email/whatsapp
}

export type RemindersValidation =
  | { ok: true; reminders: ReminderInput[] }
  | { ok: false; error: string };

/**
 * Coerce body.reminders (optional array of {remind_at, channels[]}) into a
 * validated list. Absent → null (caller leaves reminders untouched). Present →
 * full replacement set. Each reminder must select at least one channel.
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
    const chRes = coerceChannels(rec.channels);
    if (!chRes.ok) return { ok: false, error: chRes.error };
    out.push({ remind_at: remindAt, channels: chRes.channels });
  }
  return { ok: true, reminders: out };
}

// ── Recurrence rule embedded in the task body ────────────────────────────────
const FREQUENCIES: readonly RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const END_TYPES: readonly RecurrenceEndType[] = ['never', 'on_date', 'after_count'];

export type RecurrenceValidation =
  | { ok: true; rule: RecurrenceRule | null }
  | { ok: false; error: string };

/**
 * Coerce body.recurrence (optional). Semantics:
 *  - key absent       → null (caller leaves recurrence untouched).
 *  - value === null   → { rule: null } (disable / end the series).
 *  - object           → a validated rule (upsert + materialize).
 * byweekday is forced to null for non-weekly frequencies.
 */
export function coerceRecurrence(body: Record<string, unknown>): RecurrenceValidation | null {
  if (!has(body, 'recurrence')) return null;
  const raw = body.recurrence;
  if (raw === null) return { ok: true, rule: null };
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_recurrence' };
  const rec = raw as Record<string, unknown>;

  const frequency = strOrNull(rec.frequency);
  if (!frequency || !FREQUENCIES.includes(frequency as RecurrenceFrequency)) {
    return { ok: false, error: 'invalid_recurrence_frequency' };
  }

  const intervalNum = Number(rec.interval);
  if (!Number.isFinite(intervalNum) || intervalNum < 1 || intervalNum > 365) {
    return { ok: false, error: 'invalid_recurrence_interval' };
  }
  const interval = Math.floor(intervalNum);

  let byweekday: number[] | null = null;
  if (frequency === 'weekly' && rec.byweekday != null) {
    if (!Array.isArray(rec.byweekday)) return { ok: false, error: 'invalid_recurrence_byweekday' };
    const days: number[] = [];
    for (const d of rec.byweekday) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return { ok: false, error: 'invalid_recurrence_byweekday' };
      }
      if (!days.includes(n)) days.push(n);
    }
    byweekday = days.length > 0 ? days.sort((a, b) => a - b) : null;
  }

  const endTypeRaw = strOrNull(rec.endType);
  if (!endTypeRaw || !END_TYPES.includes(endTypeRaw as RecurrenceEndType)) {
    return { ok: false, error: 'invalid_recurrence_end_type' };
  }
  const endType = endTypeRaw as RecurrenceEndType;

  let endDate: string | null = null;
  let endCount: number | null = null;
  if (endType === 'on_date') {
    const d = strOrNull(rec.endDate);
    if (!d || !DATE_RE.test(d)) return { ok: false, error: 'invalid_recurrence_end_date' };
    endDate = d;
  } else if (endType === 'after_count') {
    const c = Number(rec.endCount);
    if (!Number.isFinite(c) || c < 1 || c > 366) {
      return { ok: false, error: 'invalid_recurrence_end_count' };
    }
    endCount = Math.floor(c);
  }

  return {
    ok: true,
    rule: { frequency: frequency as RecurrenceFrequency, interval, byweekday, endType, endDate, endCount },
  };
}

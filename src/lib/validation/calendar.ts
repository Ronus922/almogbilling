// Shared validation + coercion for the Calendar module — used by both
// POST /api/calendar/events and PATCH /api/calendar/events/[id].
//
// Pure (no DB, no server-only): safe to import anywhere.

import type {
  CalendarColorKey,
  CalendarEventStatus,
  CalendarEventWritableFields,
  CalendarItemKind,
  CalendarReminderInput,
  ParticipantInput,
  RecurrenceEndType,
  RecurrenceRule,
  RecurrenceType,
} from '@/lib/types/calendar';
import type { ReminderChannel } from '@/lib/types/tasks';
import { parseDateOnly } from '@/lib/calendar/recurrence';

const ITEM_KINDS: readonly CalendarItemKind[] = ['meeting', 'event'];
const STATUSES: readonly CalendarEventStatus[] = ['scheduled', 'completed', 'cancelled'];
const COLOR_KEYS: readonly CalendarColorKey[] = [
  'blue', 'emerald', 'amber', 'rose', 'violet', 'sky', 'slate',
];
const REC_TYPES: readonly RecurrenceType[] = ['daily', 'weekly', 'monthly', 'yearly'];
const REC_END_TYPES: readonly RecurrenceEndType[] = ['never', 'until_date', 'count'];
const CHANNELS: readonly ReminderChannel[] = ['in_app', 'email', 'both'];
// 'user'/'external' are the only sources the UI creates. 'contact' is accepted
// for backward-compat (legacy rows) but the picker no longer emits it.
const SOURCES = ['user', 'contact', 'external'] as const;
const EXTERNAL_NAME_MAX = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}
function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export type EventValidation =
  | { ok: true; fields: Partial<CalendarEventWritableFields> }
  | { ok: false; error: string };

/**
 * Coerce the core event fields. `mode='create'` requires title + event_date;
 * `mode='update'` validates only the keys present (partial).
 */
export function coerceEventInput(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
): EventValidation {
  const fields: Partial<CalendarEventWritableFields> = {};

  if (mode === 'create' || has(body, 'title')) {
    const title = strOrNull(body.title);
    if (!title) return { ok: false, error: 'title_required' };
    if (title.length > 300) return { ok: false, error: 'title_too_long' };
    fields.title = title;
  }

  if (mode === 'create' || has(body, 'event_date')) {
    const d = strOrNull(body.event_date);
    // parseDateOnly round-trips the date, so impossible dates (2026-02-30) are rejected.
    if (!d || !parseDateOnly(d)) {
      return { ok: false, error: 'invalid_event_date' };
    }
    fields.event_date = d;
  }

  if (has(body, 'item_kind')) {
    const k = strOrNull(body.item_kind);
    if (!k || !ITEM_KINDS.includes(k as CalendarItemKind)) {
      return { ok: false, error: 'invalid_item_kind' };
    }
    fields.item_kind = k as CalendarItemKind;
  }

  if (has(body, 'status')) {
    const s = strOrNull(body.status);
    if (!s || !STATUSES.includes(s as CalendarEventStatus)) {
      return { ok: false, error: 'invalid_status' };
    }
    fields.status = s as CalendarEventStatus;
  }

  if (has(body, 'color_key')) {
    const c = strOrNull(body.color_key);
    if (!c || !COLOR_KEYS.includes(c as CalendarColorKey)) {
      return { ok: false, error: 'invalid_color_key' };
    }
    fields.color_key = c;
  }

  if (has(body, 'is_all_day')) {
    if (typeof body.is_all_day !== 'boolean') return { ok: false, error: 'invalid_is_all_day' };
    fields.is_all_day = body.is_all_day;
  }

  if (has(body, 'location')) {
    const l = strOrNull(body.location);
    if (l && l.length > 500) return { ok: false, error: 'location_too_long' };
    fields.location = l;
  }
  if (has(body, 'description')) {
    const d = strOrNull(body.description);
    if (d && d.length > 20000) return { ok: false, error: 'description_too_long' };
    fields.description = d;
  }

  for (const key of ['start_datetime', 'end_datetime'] as const) {
    if (!has(body, key)) continue;
    const v = strOrNull(body[key]);
    if (v !== null && Number.isNaN(Date.parse(v))) {
      return { ok: false, error: `invalid_${key}` };
    }
    fields[key] = v;
  }

  if (has(body, 'owner_user_id')) {
    const id = strOrNull(body.owner_user_id);
    if (id !== null && !UUID_RE.test(id)) return { ok: false, error: 'invalid_owner_user_id' };
    fields.owner_user_id = id;
  }

  // Cross-field: end must not precede start (when both present and not all-day).
  if (fields.start_datetime && fields.end_datetime) {
    if (Date.parse(fields.end_datetime) < Date.parse(fields.start_datetime)) {
      return { ok: false, error: 'end_before_start' };
    }
  }

  return { ok: true, fields };
}

export type RecurrenceValidation =
  | { ok: true; rule: RecurrenceRule | null }
  | { ok: false; error: string };

/** Coerce body.recurrence into a validated rule. Absent/null → no recurrence. */
export function coerceRecurrence(body: Record<string, unknown>): RecurrenceValidation {
  if (!has(body, 'recurrence') || body.recurrence === null) return { ok: true, rule: null };
  const raw = body.recurrence;
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid_recurrence' };
  const rec = raw as Record<string, unknown>;

  const type = strOrNull(rec.type);
  if (!type || !REC_TYPES.includes(type as RecurrenceType)) {
    return { ok: false, error: 'invalid_recurrence_type' };
  }

  const intervalRaw = rec.interval;
  const interval = typeof intervalRaw === 'number' ? Math.floor(intervalRaw) : 1;
  if (interval < 1 || interval > 365) return { ok: false, error: 'invalid_recurrence_interval' };

  const endType = strOrNull(rec.endType) ?? 'never';
  if (!REC_END_TYPES.includes(endType as RecurrenceEndType)) {
    return { ok: false, error: 'invalid_recurrence_end_type' };
  }

  let untilDate: string | null = null;
  let count: number | null = null;

  if (endType === 'until_date') {
    untilDate = strOrNull(rec.untilDate);
    if (!untilDate || !parseDateOnly(untilDate)) {
      return { ok: false, error: 'invalid_recurrence_until_date' };
    }
  }
  if (endType === 'count') {
    const c = typeof rec.count === 'number' ? Math.floor(rec.count) : 0;
    if (c < 1 || c > 1000) return { ok: false, error: 'invalid_recurrence_count' };
    count = c;
  }

  return {
    ok: true,
    rule: { type: type as RecurrenceType, interval, endType: endType as RecurrenceEndType, untilDate, count },
  };
}

export type ParticipantsValidation =
  | { ok: true; participants: ParticipantInput[] }
  | { ok: false; error: string };

/** Coerce body.participants (optional). Absent → empty list. */
export function coerceParticipants(body: Record<string, unknown>): ParticipantsValidation {
  if (!has(body, 'participants') || body.participants === null) {
    return { ok: true, participants: [] };
  }
  const raw = body.participants;
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_participants' };
  if (raw.length > 200) return { ok: false, error: 'too_many_participants' };

  const out: ParticipantInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_participant_item' };
    const rec = item as Record<string, unknown>;
    const source = strOrNull(rec.participant_source);
    if (!source || !SOURCES.includes(source as (typeof SOURCES)[number])) {
      return { ok: false, error: 'invalid_participant_source' };
    }

    if (source === 'external') {
      // Free-text attendee: no entity id (server-forced NULL — never trust the
      // client), a trimmed non-empty name capped at 100 chars.
      const name = strOrNull(rec.display_name_cache);
      if (!name) return { ok: false, error: 'invalid_external_name' };
      if (name.length > EXTERNAL_NAME_MAX) return { ok: false, error: 'external_name_too_long' };

      const key = `external:${name.toLowerCase()}`;
      if (seen.has(key)) continue; // dedupe by name (case-insensitive)
      seen.add(key);

      out.push({
        participant_source: 'external',
        participant_id: null, // hard NULL — external attendees never carry a real id
        display_name_cache: name,
        email_cache: null,
      });
      continue;
    }

    const pid = strOrNull(rec.participant_id);

    if (source === 'contact') {
      // Legacy contacts are never CREATED by the UI — only round-tripped on a
      // save of an old event. Preserve them defensively: keep a valid id when
      // present, else fall back to a name-only row so a save never drops them.
      const name = strOrNull(rec.display_name_cache);
      const validId = pid && UUID_RE.test(pid) ? pid : null;
      if (!validId && !name) continue; // nothing to preserve
      const key = `contact:${validId ?? name?.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        participant_source: 'contact',
        participant_id: validId,
        display_name_cache: name,
        email_cache: null,
      });
      continue;
    }

    // 'user': must carry a valid entity uuid.
    if (!pid || !UUID_RE.test(pid)) return { ok: false, error: 'invalid_participant_id' };

    const key = `user:${pid}`;
    if (seen.has(key)) continue; // dedupe silently
    seen.add(key);

    out.push({
      participant_source: 'user',
      participant_id: pid,
      display_name_cache: strOrNull(rec.display_name_cache),
      email_cache: strOrNull(rec.email_cache),
    });
  }
  return { ok: true, participants: out };
}

export type CalReminderValidation =
  | { ok: true; reminders: CalendarReminderInput[] }
  | { ok: false; error: string };

/** Coerce body.reminders (optional array of {remind_at, channel}). Absent → empty. */
export function coerceCalendarReminders(body: Record<string, unknown>): CalReminderValidation {
  if (!has(body, 'reminders') || body.reminders === null) return { ok: true, reminders: [] };
  const raw = body.reminders;
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_reminders' };
  if (raw.length > 50) return { ok: false, error: 'too_many_reminders' };

  const out: CalendarReminderInput[] = [];
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

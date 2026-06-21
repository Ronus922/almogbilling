// Calendar (יומן) domain types — Module 3.
// Reuses the generic reminders engine (entity_type='calendar_event').

import type { ReminderChannel } from '@/lib/types/tasks';

export type CalendarItemKind = 'meeting' | 'event';
export type CalendarEventStatus = 'scheduled' | 'completed' | 'cancelled';
export type RecurrenceType = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurrenceEndType = 'never' | 'until_date' | 'count';
export type CalendarSourceType = 'manual' | 'generated_occurrence';
// 'user'     = system user (picker, has a login)
// 'external'  = free-text attendee (lawyer, contractor, …) — display_name only, no id
// 'contact'   = legacy; kept for backward-compat read-only display, never created via the UI
export type ParticipantSource = 'user' | 'contact' | 'external';
export type AttendanceStatus = 'pending' | 'accepted' | 'declined';

/** color_key values map to the DESIGN.md §2 tone palette. */
export type CalendarColorKey =
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'sky'
  | 'slate';

export interface CalendarEvent {
  id: string;
  title: string;
  item_kind: CalendarItemKind;
  event_date: string; // 'YYYY-MM-DD'
  start_datetime: string | null; // ISO timestamptz
  end_datetime: string | null; // ISO timestamptz
  is_all_day: boolean;
  location: string | null;
  description: string | null;
  color_key: string;
  status: CalendarEventStatus;
  owner_user_id: string | null;

  recurrence_enabled: boolean;
  recurrence_type: RecurrenceType | null;
  recurrence_interval: number;
  recurrence_end_type: RecurrenceEndType;
  recurrence_until_date: string | null; // 'YYYY-MM-DD'
  recurrence_count: number | null;

  parent_series_id: string | null;
  is_exception: boolean;
  source_type: CalendarSourceType;

  created_at: string;
  updated_at: string;
}

export interface CalendarEventParticipant {
  id: string;
  event_id: string;
  participant_source: ParticipantSource;
  /** A real entity id for 'user'/'contact'; NULL for 'external' (free-text). */
  participant_id: string | null;
  display_name_cache: string | null;
  email_cache: string | null;
  attendance_status: AttendanceStatus;
  created_at: string;
  updated_at: string;
}

/** An event enriched with its participants (for detail / panel load). */
export interface CalendarEventWithParticipants extends CalendarEvent {
  participants: CalendarEventParticipant[];
}

/** Recurrence rule supplied by the client when creating/editing a series. */
export interface RecurrenceRule {
  type: RecurrenceType;
  interval: number; // >= 1
  endType: RecurrenceEndType;
  untilDate: string | null; // 'YYYY-MM-DD' when endType='until_date'
  count: number | null; // when endType='count'
}

/**
 * A participant the client wants attached to the event.
 * 'user' → participant_id is a real users.id.
 * 'external' → participant_id is NULL; display_name_cache holds the typed name.
 */
export interface ParticipantInput {
  participant_source: ParticipantSource;
  participant_id: string | null;
  display_name_cache: string | null;
  email_cache: string | null;
}

/** A reminder the client wants attached (mirrors the tasks reminder shape). */
export interface CalendarReminderInput {
  remind_at: string; // ISO timestamptz
  channels: ReminderChannel[];
}

/** Core event fields a create/update may set (excludes recurrence bookkeeping). */
export interface CalendarEventWritableFields {
  title: string;
  item_kind: CalendarItemKind;
  event_date: string; // 'YYYY-MM-DD'
  start_datetime: string | null;
  end_datetime: string | null;
  is_all_day: boolean;
  location: string | null;
  description: string | null;
  color_key: string;
  status: CalendarEventStatus;
  owner_user_id: string | null;
}

/** Full create payload (validated server-side). */
export interface CreateCalendarEventInput extends CalendarEventWritableFields {
  recurrence: RecurrenceRule | null; // null → single event
  participants: ParticipantInput[];
  reminders: CalendarReminderInput[];
}

/** Scope for editing/deleting a recurring occurrence. */
export type SeriesEditScope = 'single' | 'future';

/** The non-event item kinds merged onto the calendar (read-only projections). */
export type CalendarOverlayKind = 'task' | 'issue' | 'reminder';

/**
 * A calendar item as returned by GET /api/calendar. Either a real event, or a
 * read-only projection of another module that has a date in range:
 *  - 'task'     — a scheduled task (tasks.due_date)
 *  - 'issue'    — an open/in_progress issue with a due_date (migration 054)
 *  - 'reminder' — a pending user_reminder the actor is involved in
 * The three overlay kinds share one shape; `kind` drives color/icon/link.
 */
export interface CalendarOverlayItem {
  kind: CalendarOverlayKind;
  id: string;
  title: string;
  event_date: string; // 'YYYY-MM-DD' (local day)
  due_time: string | null; // 'HH:MM' or null (all-day)
  priority: string | null; // tasks/issues carry one; reminders → null
  status: string;
  action_url: string; // deep link back to the source card
  /** True when this overlay row belongs to a recurring series (tasks only) →
   *  drives the recurrence glyph on the chip. */
  recurring?: boolean;
}

export type CalendarItem =
  | (CalendarEventWithParticipants & { kind: 'event' })
  | CalendarOverlayItem;

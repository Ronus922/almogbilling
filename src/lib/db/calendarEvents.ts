import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  CalendarEvent,
  CalendarEventParticipant,
  CalendarEventWithParticipants,
  CalendarEventWritableFields,
  CreateCalendarEventInput,
  ParticipantInput,
} from '@/lib/types/calendar';
import { expandRecurrence } from '@/lib/calendar/recurrence';

type Queryable = Pick<PoolClient, 'query'>;

const EVENT_COLUMNS = `
  id, title, item_kind, event_date::text as event_date, start_datetime, end_datetime,
  is_all_day, location, description, color_key, status, owner_user_id,
  recurrence_enabled, recurrence_type, recurrence_interval, recurrence_end_type,
  recurrence_until_date::text as recurrence_until_date, recurrence_count,
  parent_series_id, is_exception, source_type, created_at, updated_at
`;

const PARTICIPANT_COLUMNS = `
  id, event_id, participant_source, participant_id, display_name_cache,
  email_cache, attendance_status, created_at, updated_at
`;

// Columns the row writer sets from the writable-fields payload.
const WRITABLE_COLUMNS: (keyof CalendarEventWritableFields)[] = [
  'title', 'item_kind', 'event_date', 'start_datetime', 'end_datetime',
  'is_all_day', 'location', 'description', 'color_key', 'status', 'owner_user_id',
];

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * Events whose event_date falls within [from, to] (inclusive), each with its
 * participants. from/to are 'YYYY-MM-DD'. Returns occurrences AND standalone
 * events; the recurring PARENT row is itself a real occurrence so it is shown.
 */
export async function listEventsInRange(
  from: string,
  to: string,
): Promise<CalendarEventWithParticipants[]> {
  const r = await query<CalendarEvent>(
    `select ${EVENT_COLUMNS}
       from public.calendar_events
      where event_date >= $1 and event_date <= $2
      order by event_date asc, start_datetime asc nulls first, created_at asc`,
    [from, to],
  );
  if (r.rows.length === 0) return [];

  const ids = r.rows.map((e) => e.id);
  const pr = await query<CalendarEventParticipant>(
    `select ${PARTICIPANT_COLUMNS}
       from public.calendar_event_participants
      where event_id = any($1::uuid[])
      order by created_at asc`,
    [ids],
  );
  const byEvent = new Map<string, CalendarEventParticipant[]>();
  for (const p of pr.rows) {
    const arr = byEvent.get(p.event_id) ?? [];
    arr.push(p);
    byEvent.set(p.event_id, arr);
  }
  return r.rows.map((e) => ({ ...e, participants: byEvent.get(e.id) ?? [] }));
}

export async function getEventById(id: string): Promise<CalendarEventWithParticipants | null> {
  const event = await queryOne<CalendarEvent>(
    `select ${EVENT_COLUMNS} from public.calendar_events where id = $1 limit 1`,
    [id],
  );
  if (!event) return null;
  const pr = await query<CalendarEventParticipant>(
    `select ${PARTICIPANT_COLUMNS}
       from public.calendar_event_participants
      where event_id = $1
      order by created_at asc`,
    [id],
  );
  return { ...event, participants: pr.rows };
}

// ── Internal row writers ─────────────────────────────────────────────────────

interface RowExtras {
  recurrence_enabled?: boolean;
  recurrence_type?: string | null;
  recurrence_interval?: number;
  recurrence_end_type?: string;
  recurrence_until_date?: string | null;
  recurrence_count?: number | null;
  parent_series_id?: string | null;
  is_exception?: boolean;
  source_type?: string;
}

async function insertEventRow(
  client: Queryable,
  fields: CalendarEventWritableFields,
  extras: RowExtras,
): Promise<CalendarEvent> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const rec = fields as unknown as Record<string, unknown>;
  for (const c of WRITABLE_COLUMNS) {
    cols.push(c);
    vals.push(rec[c] ?? null);
  }
  const extraRec = extras as Record<string, unknown>;
  for (const k of Object.keys(extraRec)) {
    cols.push(k);
    vals.push(extraRec[k]);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const r = await client.query<CalendarEvent>(
    `insert into public.calendar_events (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${EVENT_COLUMNS}`,
    vals,
  );
  if (!r.rows[0]) throw new Error('failed_to_create_event');
  return r.rows[0];
}

async function insertParticipants(
  client: Queryable,
  eventId: string,
  participants: ParticipantInput[],
): Promise<void> {
  for (const p of participants) {
    await client.query(
      `insert into public.calendar_event_participants
         (event_id, participant_source, participant_id, display_name_cache, email_cache)
       values ($1, $2, $3, $4, $5)
       on conflict (event_id, participant_source, participant_id) do nothing`,
      [eventId, p.participant_source, p.participant_id, p.display_name_cache, p.email_cache],
    );
  }
}

// ── Create (single or recurring series, materialized) ────────────────────────

export interface CreateResult {
  event: CalendarEvent;
  /** Number of occurrence rows generated (1 for a single event). */
  occurrenceCount: number;
  /** True if recurrence was clipped by the materialization caps. */
  capped: boolean;
}

/**
 * Create an event. If `input.recurrence` is set, the seed row is the recurring
 * PARENT (recurrence_enabled=true, source_type='manual', parent_series_id=null)
 * and additional occurrence rows are generated (source_type='generated_occurrence',
 * parent_series_id=parent.id). Participants are copied to every occurrence; the
 * caller wires reminders to the parent only. All in one transaction.
 */
export async function createEvent(input: CreateCalendarEventInput): Promise<CreateResult> {
  const fields: CalendarEventWritableFields = {
    title: input.title,
    item_kind: input.item_kind,
    event_date: input.event_date,
    start_datetime: input.start_datetime,
    end_datetime: input.end_datetime,
    is_all_day: input.is_all_day,
    location: input.location,
    description: input.description,
    color_key: input.color_key,
    status: input.status,
    owner_user_id: input.owner_user_id,
  };

  return withTransaction(async (client) => {
    if (!input.recurrence) {
      const event = await insertEventRow(client, fields, {
        recurrence_enabled: false,
        source_type: 'manual',
      });
      await insertParticipants(client, event.id, input.participants);
      return { event, occurrenceCount: 1, capped: false };
    }

    const { dates, capped } = expandRecurrence(input.event_date, input.recurrence);
    const seedDate = dates[0] ?? input.event_date;

    // Parent / first occurrence carries the recurrence rule.
    const parent = await insertEventRow(client, { ...fields, event_date: seedDate }, {
      recurrence_enabled: true,
      recurrence_type: input.recurrence.type,
      recurrence_interval: input.recurrence.interval,
      recurrence_end_type: input.recurrence.endType,
      recurrence_until_date: input.recurrence.untilDate,
      recurrence_count: input.recurrence.count,
      parent_series_id: null,
      is_exception: false,
      source_type: 'manual',
    });
    await insertParticipants(client, parent.id, input.participants);

    // Remaining occurrences (skip index 0 = the parent's seed date).
    for (let i = 1; i < dates.length; i++) {
      const occ = await insertEventRow(client, { ...fields, event_date: dates[i] }, {
        recurrence_enabled: false,
        parent_series_id: parent.id,
        is_exception: false,
        source_type: 'generated_occurrence',
      });
      await insertParticipants(client, occ.id, input.participants);
    }

    return { event: parent, occurrenceCount: dates.length, capped };
  });
}

// ── Update ────────────────────────────────────────────────────────────────

/**
 * Update a SINGLE event/occurrence's fields + participants. When the event is a
 * generated occurrence (or a parent), flag is_exception=true so a later
 * series-wide "future" edit leaves this hand-edited row alone. Participants are
 * fully replaced. One transaction.
 */
export async function updateSingleEvent(
  id: string,
  fields: Partial<CalendarEventWritableFields>,
  participants: ParticipantInput[] | null,
): Promise<CalendarEvent | null> {
  return withTransaction(async (client) => {
    const existing = await client.query<{ parent_series_id: string | null; source_type: string }>(
      `select parent_series_id, source_type from public.calendar_events where id = $1 for update`,
      [id],
    );
    if (!existing.rows[0]) return null;

    const rec = fields as Record<string, unknown>;
    const set: string[] = [];
    const vals: unknown[] = [id];
    for (const c of WRITABLE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(rec, c) && rec[c] !== undefined) {
        vals.push(rec[c]);
        set.push(`${c} = $${vals.length}`);
      }
    }
    // Editing one occurrence detaches it from series-wide future edits.
    const isOccurrence =
      existing.rows[0].source_type === 'generated_occurrence' ||
      existing.rows[0].parent_series_id !== null;
    if (isOccurrence) {
      set.push(`is_exception = true`);
    }

    let updated: CalendarEvent | null;
    if (set.length === 0) {
      updated = await client.query<CalendarEvent>(
        `select ${EVENT_COLUMNS} from public.calendar_events where id = $1`,
        [id],
      ).then((r) => r.rows[0] ?? null);
    } else {
      const r = await client.query<CalendarEvent>(
        `update public.calendar_events set ${set.join(', ')} where id = $1 returning ${EVENT_COLUMNS}`,
        vals,
      );
      updated = r.rows[0] ?? null;
    }

    if (participants !== null && updated) {
      await client.query(`delete from public.calendar_event_participants where event_id = $1`, [id]);
      await insertParticipants(client, id, participants);
    }
    return updated;
  });
}

/**
 * Apply a field patch to a whole series "from this occurrence forward".
 * Touches only occurrences of the SAME series whose event_date >= the anchor
 * date and that are NOT exceptions (hand-edited single occurrences are left
 * intact). Series membership = the anchor itself + everything sharing its
 * series root. Returns number of rows updated.
 *
 * Field updates here exclude event_date (shifting dates across a series is not
 * supported — that would require re-materialization). Participants are replaced
 * on every affected occurrence when supplied.
 */
export async function updateSeriesFuture(
  anchorId: string,
  fields: Partial<CalendarEventWritableFields>,
  participants: ParticipantInput[] | null,
): Promise<{ updated: number } | null> {
  return withTransaction(async (client) => {
    const anchor = await client.query<{
      id: string;
      event_date: string;
      parent_series_id: string | null;
    }>(
      `select id, event_date::text as event_date, parent_series_id
         from public.calendar_events where id = $1 for update`,
      [anchorId],
    );
    if (!anchor.rows[0]) return null;

    // Series root = the parent if this is an occurrence, else the anchor itself.
    const seriesRoot = anchor.rows[0].parent_series_id ?? anchor.rows[0].id;
    const anchorDate = anchor.rows[0].event_date;

    // Build the field patch (exclude event_date — series keeps its cadence).
    const rec = fields as Record<string, unknown>;
    const set: string[] = [];
    const baseVals: unknown[] = [];
    for (const c of WRITABLE_COLUMNS) {
      if (c === 'event_date') continue;
      if (Object.prototype.hasOwnProperty.call(rec, c) && rec[c] !== undefined) {
        baseVals.push(rec[c]);
        set.push(`${c} = $${baseVals.length}`);
      }
    }

    // Affected rows: this series (root + its occurrences), date >= anchor,
    // not exceptions. CRITICAL: scoped to the exact series — never another.
    const seriesPredicate = `(id = $${baseVals.length + 1} or parent_series_id = $${baseVals.length + 1})
                             and event_date >= $${baseVals.length + 2}
                             and is_exception = false`;
    const whereVals = [...baseVals, seriesRoot, anchorDate];

    let updated = 0;
    if (set.length > 0) {
      const r = await client.query(
        `update public.calendar_events
            set ${set.join(', ')}
          where ${seriesPredicate}`,
        whereVals,
      );
      updated = r.rowCount ?? 0;
    } else {
      const r = await client.query<{ id: string }>(
        `select id from public.calendar_events where ${seriesPredicate}`,
        whereVals,
      );
      updated = r.rows.length;
    }

    // Replace participants across every affected occurrence when supplied.
    if (participants !== null) {
      const affected = await client.query<{ id: string }>(
        `select id from public.calendar_events where ${seriesPredicate}`,
        whereVals,
      );
      for (const row of affected.rows) {
        await client.query(
          `delete from public.calendar_event_participants where event_id = $1`,
          [row.id],
        );
        await insertParticipants(client, row.id, participants);
      }
    }

    return { updated };
  });
}

// ── Delete ──────────────────────────────────────────────────────────────────

/** Delete a single event/occurrence (participants cascade). */
export async function deleteSingleEvent(id: string): Promise<boolean> {
  const r = await query(`delete from public.calendar_events where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Delete "this and future": removes the anchor and all NON-exception
 * occurrences of the SAME series with event_date >= anchor's date. Exceptions
 * (hand-edited occurrences) survive. Returns the ids that were deleted (so the
 * caller can clean up their reminders) — empty array means anchor not found.
 * CRITICAL: scoped to the exact series root — cannot touch another series.
 */
export async function deleteSeriesFuture(anchorId: string): Promise<string[]> {
  return withTransaction(async (client) => {
    const anchor = await client.query<{
      id: string;
      event_date: string;
      parent_series_id: string | null;
    }>(
      `select id, event_date::text as event_date, parent_series_id
         from public.calendar_events where id = $1 for update`,
      [anchorId],
    );
    if (!anchor.rows[0]) return [];

    const seriesRoot = anchor.rows[0].parent_series_id ?? anchor.rows[0].id;
    const anchorDate = anchor.rows[0].event_date;

    const r = await client.query<{ id: string }>(
      `delete from public.calendar_events
        where (id = $1 or parent_series_id = $1)
          and event_date >= $2
          and (is_exception = false or id = $3)
        returning id`,
      [seriesRoot, anchorDate, anchorId],
    );
    return r.rows.map((row) => row.id);
  });
}

/** Read just owner/series metadata for an event (lightweight existence check). */
export async function getEventMeta(
  id: string,
): Promise<{ id: string; owner_user_id: string | null; parent_series_id: string | null; source_type: string } | null> {
  return queryOne(
    `select id, owner_user_id, parent_series_id, source_type
       from public.calendar_events where id = $1 limit 1`,
    [id],
  );
}

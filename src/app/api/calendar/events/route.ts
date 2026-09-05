import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { createEvent } from '@/lib/db/calendarEvents';
import { createReminder } from '@/lib/db/reminders';
import {
  coerceEventInput,
  coerceRecurrence,
  coerceParticipants,
  coerceCalendarReminders,
} from '@/lib/validation/calendar';
import type { CalendarEventWritableFields, CreateCalendarEventInput } from '@/lib/types/calendar';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/calendar/events  (calendar:edit)
// Creates a single event or a recurring series (materialized occurrences).
// Reminders are attached to the parent/series row only.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('calendar', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const ev = coerceEventInput(bodyRec, 'create');
  if (!ev.ok) return NextResponse.json({ error: ev.error }, { status: 400 });

  const rec = coerceRecurrence(bodyRec);
  if (!rec.ok) return NextResponse.json({ error: rec.error }, { status: 400 });

  const parts = coerceParticipants(bodyRec);
  if (!parts.ok) return NextResponse.json({ error: parts.error }, { status: 400 });

  const rems = coerceCalendarReminders(bodyRec);
  if (!rems.ok) return NextResponse.json({ error: rems.error }, { status: 400 });

  // Fill defaults for required writable fields the client may omit.
  const fields = ev.fields as Partial<CalendarEventWritableFields>;
  const input: CreateCalendarEventInput = {
    title: fields.title!,
    event_date: fields.event_date!,
    item_kind: fields.item_kind ?? 'meeting',
    start_datetime: fields.start_datetime ?? null,
    end_datetime: fields.end_datetime ?? null,
    is_all_day: fields.is_all_day ?? false,
    location: fields.location ?? null,
    description: fields.description ?? null,
    color_key: fields.color_key ?? 'blue',
    status: fields.status ?? 'scheduled',
    // Owner = the creator, always derived from the session. Any owner_user_id
    // in the client payload is ignored — ownership cannot be forged or assigned.
    owner_user_id: actor.id,
    recurrence: rec.rule,
    participants: parts.participants,
    reminders: rems.reminders,
  };

  try {
    const result = await createEvent(input);

    // Reminders fire for the current actor, anchored to the parent/series row.
    for (const r of rems.reminders) {
      await createReminder({
        entityType: 'calendar_event',
        entityId: result.event.id,
        userId: actor.id,
        remindAt: r.remind_at,
        channels: r.channels,
      });
    }

    return NextResponse.json(
      { event: result.event, occurrenceCount: result.occurrenceCount, capped: result.capped },
      { status: 201 },
    );
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    logger.error('[POST /api/calendar/events]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

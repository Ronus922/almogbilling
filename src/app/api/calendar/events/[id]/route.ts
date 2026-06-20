import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getEventById,
  getEventMeta,
  updateSingleEvent,
  updateSeriesFuture,
  deleteSingleEvent,
  deleteSeriesFuture,
} from '@/lib/db/calendarEvents';
import {
  listRemindersForEntity,
  createReminder,
  deleteRemindersForEntity,
} from '@/lib/db/reminders';
import {
  coerceEventInput,
  coerceParticipants,
  coerceCalendarReminders,
} from '@/lib/validation/calendar';
import type { SeriesEditScope } from '@/lib/types/calendar';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

function parseScope(v: unknown): SeriesEditScope {
  return v === 'future' ? 'future' : 'single';
}

/** The reminder-anchor for an event is its series root (parent if occurrence). */
function reminderAnchor(meta: { id: string; parent_series_id: string | null }): string {
  return meta.parent_series_id ?? meta.id;
}

// GET /api/calendar/events/[id] — event + participants + reminders  (calendar:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('calendar', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const event = await getEventById(id);
  if (!event) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Reminders live on the series root.
  const anchorId = event.parent_series_id ?? event.id;
  const reminders = await listRemindersForEntity('calendar_event', anchorId);
  return NextResponse.json({ event, reminders });
}

// PATCH /api/calendar/events/[id]  (calendar:edit)
// body.scope = 'single' (default) | 'future'. Recurrence rule changes are not
// applied via PATCH — only fields + participants (+ reminders, single scope).
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('calendar', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;
  const scope = parseScope(bodyRec.scope);

  const ev = coerceEventInput(bodyRec, 'update');
  if (!ev.ok) return NextResponse.json({ error: ev.error }, { status: 400 });

  const parts = coerceParticipants(bodyRec);
  if (!parts.ok) return NextResponse.json({ error: parts.error }, { status: 400 });
  // participants present in body → replacement set; absent → null (leave intact)
  const participantsPatch =
    Object.prototype.hasOwnProperty.call(bodyRec, 'participants') && bodyRec.participants !== null
      ? parts.participants
      : null;

  const meta = await getEventMeta(id);
  if (!meta) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    if (scope === 'future') {
      const result = await updateSeriesFuture(id, ev.fields, participantsPatch);
      if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      return NextResponse.json({ updated: result.updated, scope });
    }

    const updated = await updateSingleEvent(id, ev.fields, participantsPatch);
    if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Reminders are only managed at single scope and only on the series root.
    const rems = coerceCalendarReminders(bodyRec);
    if (!rems.ok) return NextResponse.json({ error: rems.error }, { status: 400 });
    if (Object.prototype.hasOwnProperty.call(bodyRec, 'reminders')) {
      const anchorId = reminderAnchor(meta);
      await deleteRemindersForEntity('calendar_event', anchorId);
      for (const r of rems.reminders) {
        await createReminder({
          entityType: 'calendar_event',
          entityId: anchorId,
          userId: actor.id,
          remindAt: r.remind_at,
          channels: r.channels,
        });
      }
    }

    return NextResponse.json({ event: updated, scope });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    console.error('[PATCH /api/calendar/events/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/calendar/events/[id]?scope=single|future  (calendar:edit)
export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('calendar', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const scope = parseScope(req.nextUrl.searchParams.get('scope'));

  const meta = await getEventMeta(id);
  if (!meta) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const anchorId = reminderAnchor(meta);

  try {
    if (scope === 'future') {
      const deletedIds = await deleteSeriesFuture(id);
      if (deletedIds.length === 0) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      // If the series root itself was deleted, drop its reminders too.
      if (deletedIds.includes(anchorId)) {
        await deleteRemindersForEntity('calendar_event', anchorId);
      }
      return NextResponse.json({ deleted: deletedIds.length, scope });
    }

    const ok = await deleteSingleEvent(id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // Reminders are anchored to the series root; only drop them when deleting it.
    if (anchorId === id) {
      await deleteRemindersForEntity('calendar_event', id);
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error('[DELETE /api/calendar/events/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listEventsInRange } from '@/lib/db/calendarEvents';
import { listTasksWithDueDateInRange } from '@/lib/db/tasks';
import type { CalendarItem } from '@/lib/types/calendar';

export const runtime = 'nodejs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Cap a single fetch to ~13 months to prevent scraping the whole table.
const MAX_RANGE_DAYS = 400;

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD  (calendar:view)
// Returns calendar events in range + read-only tasks whose due_date is in range.
export async function GET(req: NextRequest) {
  try {
    await requirePermission('calendar', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const from = sp.get('from')?.trim() ?? '';
  const to = sp.get('to')?.trim() ?? '';

  // from/to are MANDATORY and bounded — no open-ended dumps of the whole table.
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'invalid_range' }, { status: 400 });
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) {
    return NextResponse.json({ error: 'invalid_range' }, { status: 400 });
  }
  const spanDays = (toMs - fromMs) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: 'range_too_large' }, { status: 400 });
  }

  try {
    const [events, tasks] = await Promise.all([
      listEventsInRange(from, to),
      listTasksWithDueDateInRange(from, to),
    ]);

    const items: CalendarItem[] = [
      ...events.map((e) => ({ ...e, kind: 'event' as const })),
      ...tasks.map((t) => ({
        kind: 'task' as const,
        id: t.id,
        title: t.title,
        event_date: t.due_date,
        due_time: t.due_time ? t.due_time.slice(0, 5) : null,
        priority: t.priority,
        status: t.status,
        action_url: `/tasks?task=${t.id}`,
      })),
    ];

    return NextResponse.json({ items });
  } catch (err) {
    console.error('[GET /api/calendar]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

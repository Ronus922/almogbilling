import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { hasPermission } from '@/lib/permissions/check';
import { listEventsInRange } from '@/lib/db/calendarEvents';
import { listTasksWithDueDateInRange } from '@/lib/db/tasks';
import { listIssuesWithDueDateInRange } from '@/lib/db/issues';
import { listUserRemindersInRange } from '@/lib/db/userReminders';
import type { CalendarItem } from '@/lib/types/calendar';

export const runtime = 'nodejs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Cap a single fetch to ~13 months to prevent scraping the whole table.
const MAX_RANGE_DAYS = 400;

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD  (calendar:view)
// Returns calendar events in range + read-only overlays whose date is in range:
//   tasks (scheduled), issues (open/in_progress w/ due_date), and the actor's
//   own pending reminders (only when they hold user_reminders:view).
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('calendar', 'view');
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

  // Reminders are a per-user overlay; only fetch them when the actor can see the
  // reminders module (and only their own — created_by/assigned_to = actor).
  const canSeeReminders = hasPermission(actor.role, actor.permissions, 'user_reminders', 'view');

  try {
    const [events, tasks, issues, reminders] = await Promise.all([
      listEventsInRange(from, to),
      listTasksWithDueDateInRange(from, to),
      listIssuesWithDueDateInRange(from, to),
      canSeeReminders ? listUserRemindersInRange(from, to, actor.id) : Promise.resolve([]),
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
        recurring: t.recurring,
      })),
      ...issues.map((i) => ({
        kind: 'issue' as const,
        id: i.id,
        title: i.title,
        event_date: i.due_date,
        due_time: i.due_time ? i.due_time.slice(0, 5) : null,
        priority: i.priority,
        status: i.status,
        action_url: `/issues?issue=${i.id}`,
      })),
      ...reminders.map((r) => ({
        kind: 'reminder' as const,
        id: r.id,
        title: r.title,
        event_date: r.event_date,
        due_time: r.due_time,
        priority: null,
        status: r.status,
        action_url: '/user-reminders',
      })),
    ];

    return NextResponse.json({ items });
  } catch (err) {
    console.error('[GET /api/calendar]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

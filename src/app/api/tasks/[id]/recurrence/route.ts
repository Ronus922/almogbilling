import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  endTaskSeries,
  skipTaskOccurrence,
  detachTaskOccurrence,
} from '@/lib/recurrence/series';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

type RecurrenceAction = 'skip' | 'end' | 'detach';
const ACTIONS: readonly RecurrenceAction[] = ['skip', 'end', 'detach'];

// POST /api/tasks/[id]/recurrence  { action: 'skip' | 'end' | 'detach' }   (tasks:edit)
// Per-occurrence / series operations from the edit drawer. No new permission —
// reuses the existing tasks:edit layer.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('tasks', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const action = (body as Record<string, unknown>)?.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as RecurrenceAction)) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
  }

  try {
    // Under the single-row model these all operate on the series row itself:
    // 'skip' and 'detach' advance it past the current occurrence, 'end' just puts
    // the rule to sleep (there are no future rows to clean up).
    switch (action as RecurrenceAction) {
      case 'end': {
        if (!(await endTaskSeries(id))) {
          return NextResponse.json({ error: 'not_applicable' }, { status: 400 });
        }
        return NextResponse.json({ ok: true });
      }
      case 'skip': {
        const advance = await skipTaskOccurrence(id);
        if (!advance) return NextResponse.json({ error: 'not_applicable' }, { status: 400 });
        return NextResponse.json({ ok: true, ...advance });
      }
      case 'detach': {
        const result = await detachTaskOccurrence(id, actor.id);
        if (!result) return NextResponse.json({ error: 'not_applicable' }, { status: 400 });
        // detached_task_id lets the drawer reopen on the standalone copy.
        return NextResponse.json({ ok: true, ...result });
      }
    }
  } catch (err) {
    console.error('[POST /api/tasks/[id]/recurrence]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

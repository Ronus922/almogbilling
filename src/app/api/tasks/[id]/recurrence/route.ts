import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  endTaskSeries,
  skipTaskOccurrence,
  detachTaskOccurrence,
} from '@/lib/recurrence/materialize';

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
  try {
    await requirePermission('tasks', 'edit');
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
    let ok: boolean;
    switch (action as RecurrenceAction) {
      case 'end':
        ok = await endTaskSeries(id);
        break;
      case 'skip':
        ok = await skipTaskOccurrence(id);
        break;
      case 'detach':
        ok = await detachTaskOccurrence(id);
        break;
      default:
        ok = false;
    }
    if (!ok) {
      // Not part of a series, or skip/detach attempted on a non-instance.
      return NextResponse.json({ error: 'not_applicable' }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/tasks/[id]/recurrence]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

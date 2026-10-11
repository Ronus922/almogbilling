import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { isUuid } from '@/lib/validation/issues';
import { getIssueById } from '@/lib/db/issues';
import { getTaskById } from '@/lib/db/tasks';
import { reorderWorkItemWithinLane } from '@/lib/db/workItems';
import { actorMayAccessWorkItem } from '@/lib/auth/workItemAccess';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ kind: string; id: string }>;
}

// PATCH /api/work-items/[kind]/[id]/move  { before_id: uuid | null }
// Unified module (11/10/2026) board — manual reorder WITHIN the same lane
// (primary assignee) and priority tier only. Moving a card to a different
// lane is a reassignment — see .../assignee. (tasks:edit | issues:edit)
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { kind, id } = await ctx.params;
  if (kind !== 'issue' && kind !== 'task') {
    return NextResponse.json({ error: 'invalid_kind' }, { status: 404 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let actor: Actor;
  try {
    actor = await requirePermission(kind === 'issue' ? 'issues' : 'tasks', 'edit');
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
  const beforeIdRaw = (body as Record<string, unknown>)?.before_id;
  if (beforeIdRaw !== null && typeof beforeIdRaw !== 'string') {
    return NextResponse.json({ error: 'invalid_before_id' }, { status: 400 });
  }
  const beforeId = beforeIdRaw === null ? null : beforeIdRaw;
  if (beforeId !== null && !isUuid(beforeId)) {
    return NextResponse.json({ error: 'invalid_before_id' }, { status: 400 });
  }

  const existing = kind === 'issue' ? await getIssueById(id) : await getTaskById(id);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!actorMayAccessWorkItem(actor, existing)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const result = await reorderWorkItemWithinLane(kind, id, beforeId);
    if (result === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (result === 'cross_lane') return NextResponse.json({ error: 'cross_lane' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[PATCH /api/work-items/[kind]/[id]/move]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { isUuid } from '@/lib/validation/issues';
import { getIssueById, updateIssue } from '@/lib/db/issues';
import { getTaskById, updateTask } from '@/lib/db/tasks';
import { actorMayAccessWorkItem } from '@/lib/auth/workItemAccess';
import { nextIssueStatusOnChip, nextTaskStatusOnChip } from '@/lib/workItems/status';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ kind: string; id: string }>;
}

// PATCH /api/work-items/[kind]/[id]/status  (no body)
// Unified module (11/10/2026) — chip-click advance: open -> in_progress ->
// closed. A closed item does not advance further from here (reopening is an
// explicit action in the full edit panel). (tasks:edit | issues:edit)
export async function PATCH(_req: NextRequest, ctx: RouteCtx) {
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

  try {
    if (kind === 'issue') {
      const existing = await getIssueById(id);
      if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      if (!actorMayAccessWorkItem(actor, existing)) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      const next = nextIssueStatusOnChip(existing.status);
      if (!next) return NextResponse.json({ error: 'already_closed' }, { status: 400 });
      const updated = await updateIssue(id, { status: next });
      return NextResponse.json({ item: updated });
    }

    const existing = await getTaskById(id);
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (!actorMayAccessWorkItem(actor, existing)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const next = nextTaskStatusOnChip(existing.status);
    if (!next) return NextResponse.json({ error: 'already_closed' }, { status: 400 });
    const updated = await updateTask(id, { status: next });
    return NextResponse.json({ item: updated });
  } catch (err) {
    logger.error('[PATCH /api/work-items/[kind]/[id]/status]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

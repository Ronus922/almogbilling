import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { isUuid } from '@/lib/validation/issues';
import { getIssueById } from '@/lib/db/issues';
import { getTaskById } from '@/lib/db/tasks';
import { restoreWorkItem } from '@/lib/db/workItems';
import { actorMayAccessWorkItem } from '@/lib/auth/workItemAccess';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ kind: string; id: string }>;
}

// PATCH /api/work-items/[kind]/[id]/restore  (no body)
// Unified module (11/10/2026) archive tab — the one mutation it has.
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

  const existing = kind === 'issue' ? await getIssueById(id) : await getTaskById(id);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!actorMayAccessWorkItem(actor, existing)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const ok = await restoreWorkItem(kind, id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[PATCH /api/work-items/[kind]/[id]/restore]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

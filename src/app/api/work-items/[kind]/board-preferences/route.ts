import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getWorkBoardOrder, setWorkBoardOrder } from '@/lib/db/workBoardOrder';
import { parseJsonBody } from '@/lib/http/body';
import { workBoardOrderBodySchema } from '@/lib/validation/requests';
import { logger } from '@/lib/logger';
import type { WorkItemKind } from '@/lib/types/workItems';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ kind: string }>;
}

function parseKind(raw: string): WorkItemKind | null {
  return raw === 'issue' || raw === 'task' ? raw : null;
}

// GET /api/work-items/[kind]/board-preferences  (issues|tasks:view)
// Which lanes this viewer has pinned on their own board, in order — employee
// uuids plus, optionally, the SUPPLIERS_LANE_ID sentinel for "ספקים". null =
// never customized — the screen falls back to the default algorithm (only
// employees/suppliers with an open item in scope, busiest first then
// alphabetical for employees, suppliers last when present).
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const { kind: kindRaw } = await ctx.params;
  const kind = parseKind(kindRaw);
  if (!kind) return NextResponse.json({ error: 'invalid_kind' }, { status: 404 });

  let actor: Actor;
  try {
    actor = await requirePermission(kind === 'issue' ? 'issues' : 'tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  try {
    const employeeIds = await getWorkBoardOrder(actor.id, kind);
    return NextResponse.json({ employeeIds });
  } catch (err) {
    logger.error('[GET /api/work-items/[kind]/board-preferences]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// PUT /api/work-items/[kind]/board-preferences  { employeeIds: (uuid|'suppliers')[] }
// (issues|tasks:view — a personal display preference, not an edit of any
// issue/task, so view access is enough; same reasoning as PUT
// /api/user-reminders/order.) Full replace: exactly this set, in this order.
export async function PUT(req: NextRequest, ctx: RouteCtx) {
  const { kind: kindRaw } = await ctx.params;
  const kind = parseKind(kindRaw);
  if (!kind) return NextResponse.json({ error: 'invalid_kind' }, { status: 404 });

  let actor: Actor;
  try {
    actor = await requirePermission(kind === 'issue' ? 'issues' : 'tasks', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const body = await parseJsonBody(req, workBoardOrderBodySchema);
  if (!body.ok) return body.response;

  try {
    await setWorkBoardOrder(actor.id, kind, body.data.employeeIds);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[PUT /api/work-items/[kind]/board-preferences]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

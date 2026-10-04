import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { issueScopeUserId } from '@/lib/auth/issueAccess';
import { moveIssueOnBoard } from '@/lib/db/issues';
import { parseJsonBody } from '@/lib/http/body';
import { jerusalemToday } from '@/lib/issues/board';
import { isUuid } from '@/lib/validation/issues';
import { issueBoardMoveBodySchema } from '@/lib/validation/requests';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PATCH /api/issues/[id]/move — a drop on the issues kanban (issues:edit).
// Body: { column: 'awaiting' | 'today' | 'in_progress', before_id: uuid | null }
// The card lands in that column directly above before_id (null = the bottom)
// and stays there: board_column + sort_order, nothing else — not the handlers,
// the date, the priority or the status (lib/issues/board.ts, 04/10/2026).
//
// The board is the manager screen; a field worker has none (issues/page.tsx),
// and a drop renumbers other people's cards, so a scoped worker is refused.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('issues', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  if (issueScopeUserId(actor) !== null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = await parseJsonBody(req, issueBoardMoveBodySchema);
  if (!body.ok) return body.response;

  try {
    const result = await moveIssueOnBoard(id, body.data.column, body.data.before_id, jerusalemToday());
    switch (result) {
      case 'moved':
        return NextResponse.json({ ok: true });
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'not_on_board':
      case 'stale':
        // Archived / resolved / closed meanwhile, or before_id left the
        // column — the client puts the card back and reloads the board.
        return NextResponse.json({ error: result }, { status: 409 });
    }
  } catch (err) {
    logger.error('[PATCH /api/issues/[id]/move]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

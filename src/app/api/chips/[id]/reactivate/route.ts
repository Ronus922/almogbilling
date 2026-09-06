import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { reactivateChip, ChipNumberTakenError, ChipStateError } from '@/lib/db/chips';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/chips/[id]/reactivate (chips:edit) — inactive -> active, the ONLY
// way back. Always resets controller_synced=false (handled in the db layer).
// The reason is OPTIONAL (the one-click toggle sends none) — an empty or absent
// body is valid and logs a reactivated event with reason=null.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  // An empty body is the normal case (one-click toggle) — never an error here.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const reasonRaw = typeof bodyRec.reason === 'string' ? bodyRec.reason.trim() : '';
  const reason = reasonRaw !== '' ? reasonRaw : null;

  try {
    const chip = await reactivateChip(
      id,
      { reason },
      { id: actor.id, name: actor.full_name ?? actor.username },
    );
    if (!chip) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ chip });
  } catch (err) {
    if (err instanceof ChipNumberTakenError) {
      return NextResponse.json(
        { error: 'מספר הצ׳יפ כבר בשימוש אצל צ׳יפ פעיל אחר' },
        { status: 409 },
      );
    }
    if (err instanceof ChipStateError) {
      return NextResponse.json({ error: 'הצ׳יפ כבר פעיל' }, { status: 409 });
    }
    logger.error('[POST /api/chips/:id/reactivate]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markControllerSynced } from '@/lib/db/chips';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/chips/[id]/controller-sync (chips:edit) — confirm the physical
// controller learned about a pending change. Idempotent.
export async function POST(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  try {
    const chip = await markControllerSynced(id, {
      id: actor.id,
      name: actor.full_name ?? actor.username,
    });
    if (!chip) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ chip });
  } catch (err) {
    logger.error('[POST /api/chips/:id/controller-sync]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

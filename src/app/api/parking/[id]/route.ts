import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { updateParkingSpot } from '@/lib/db/parking';
import { isUuid, parkingBadRequest, parkingErrorResponse, parkingNotFound } from '@/lib/parking/apiErrors';
import { coerceAndValidateParkingSpot } from '@/lib/validation/parking';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PATCH /api/parking/[id] (parking:edit) — whole-object save.
//
// There is deliberately no DELETE on this route. Removing a spot is
// POST /api/parking/[id]/toggle-active with a reason; a physical spot never
// stops existing, it only stops being assigned.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('parking', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) return parkingNotFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return parkingBadRequest('invalid_json');
  }

  const result = coerceAndValidateParkingSpot((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const spot = await updateParkingSpot(id, result.fields, actor.id);
    if (!spot) return parkingNotFound();
    return NextResponse.json({ spot });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    logger.error('[PATCH /api/parking/:id]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

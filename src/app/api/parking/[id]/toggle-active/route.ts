import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { toggleParkingSpotActive } from '@/lib/db/parking';
import { isUuid, parkingBadRequest, parkingErrorResponse, parkingNotFound } from '@/lib/parking/apiErrors';
import { coerceAndValidateToggleActive } from '@/lib/validation/parking';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/parking/[id]/toggle-active (parking:edit)
// Replaces DELETE entirely. Body: { is_active: boolean, reason?: string } —
// `reason` is mandatory when switching OFF.
export async function POST(req: NextRequest, ctx: RouteCtx) {
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

  const result = coerceAndValidateToggleActive((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const spot = await toggleParkingSpotActive(
      id, result.fields.is_active, result.fields.reason, actor.id,
    );
    if (!spot) return parkingNotFound();
    return NextResponse.json({ spot });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    logger.error('[POST /api/parking/:id/toggle-active]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

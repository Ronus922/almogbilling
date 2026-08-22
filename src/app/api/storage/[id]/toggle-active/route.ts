import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { toggleStorageUnitActive } from '@/lib/db/parking';
import { parkingBadRequest, parkingErrorResponse, parkingNotFound } from '@/lib/parking/apiErrors';
import { coerceAndValidateToggleActive } from '@/lib/validation/parking';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/storage/[id]/toggle-active (parking:edit)
// Body: { is_active: boolean, reason?: string } — `reason` mandatory when
// switching OFF. Switching a unit back ON can 409: its number may have been
// re-issued while it was released.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return parkingBadRequest('invalid_json');
  }

  const result = coerceAndValidateToggleActive((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const unit = await toggleStorageUnitActive(
      id, result.fields.is_active, result.fields.reason, actor.id,
    );
    if (!unit) return parkingNotFound();
    return NextResponse.json({ unit });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    console.error('[POST /api/storage/:id/toggle-active]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

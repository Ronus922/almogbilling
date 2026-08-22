import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { updateStorageUnit } from '@/lib/db/parking';
import { parkingBadRequest, parkingErrorResponse, parkingNotFound } from '@/lib/parking/apiErrors';
import { coerceAndValidateStorageUnit } from '@/lib/validation/parking';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// PATCH /api/storage/[id] (parking:edit) — whole-object save.
// No DELETE: releasing a unit is POST /api/storage/[id]/toggle-active, which
// also frees the number for re-issue (partial unique on is_active).
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return parkingBadRequest('invalid_json');
  }

  const result = coerceAndValidateStorageUnit((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const unit = await updateStorageUnit(id, result.fields, actor.id);
    if (!unit) return parkingNotFound();
    return NextResponse.json({ unit });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    console.error('[PATCH /api/storage/:id]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

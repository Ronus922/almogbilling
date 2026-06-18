import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getAreaById, updateArea, deleteArea } from '@/lib/db/areas';
import { coerceAndValidateArea } from '@/lib/validation/areas';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/areas/[id] (rooms_areas:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('rooms_areas', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const area = await getAreaById(id);
  if (!area) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ area });
}

// PATCH /api/areas/[id] (rooms_areas:edit) — whole-object save.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('rooms_areas', 'edit');
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
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const result = coerceAndValidateArea((body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const ok = await updateArea(id, result.fields);
    if (!ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /api/areas/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/areas/[id] (rooms_areas:edit) — hard delete.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('rooms_areas', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await deleteArea(id);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

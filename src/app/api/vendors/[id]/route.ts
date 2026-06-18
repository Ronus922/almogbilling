import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getVendorById, updateVendor, softDeleteVendor } from '@/lib/db/vendors';
import { coerceAndValidateVendor } from '@/lib/validation/vendors';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/vendors/[id] (vendors:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('vendors', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const vendor = await getVendorById(id);
  if (!vendor) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ vendor });
}

// PATCH /api/vendors/[id] (vendors:edit) — whole-object save.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('vendors', 'edit');
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

  const result = coerceAndValidateVendor((body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    const ok = await updateVendor(id, result.fields);
    if (!ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
    }
    console.error('[PATCH /api/vendors/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/vendors/[id] (vendors:edit) — soft delete (is_active=false).
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('vendors', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const ok = await softDeleteVendor(id);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

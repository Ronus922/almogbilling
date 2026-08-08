import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipById, updateChip } from '@/lib/db/chips';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/chips/[id] (chips:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const chip = await getChipById(id);
  if (!chip) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ chip });
}

// PATCH /api/chips/[id] (chips:edit) — partial update. The writable whitelist
// lives in the db layer: chip_number and status are NEVER writable here.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
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

  try {
    const chip = await updateChip(
      id,
      (body ?? {}) as Record<string, unknown>,
      { id: actor.id, name: actor.full_name ?? actor.username },
    );
    if (!chip) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ chip });
  } catch (err) {
    if (err instanceof Error && err.message === 'contact_not_found') {
      return NextResponse.json({ error: 'הדירה לא נמצאה במרשם' }, { status: 404 });
    }
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    if (e.code === '23514') {
      return NextResponse.json({ error: 'invalid_value' }, { status: 400 });
    }
    console.error('[PATCH /api/chips/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

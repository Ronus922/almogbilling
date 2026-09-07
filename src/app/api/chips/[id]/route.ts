import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipById, updateChip, ChipNumberTakenError } from '@/lib/db/chips';
import { logger } from '@/lib/logger';

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
// lives in the db layer: status is NEVER writable here; chip_number is a
// CORRECTION that 409s when another active chip already holds the number.
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
    if (err instanceof ChipNumberTakenError) {
      return NextResponse.json(
        { error: `מספר צ׳יפ ${err.chipNumber} כבר פעיל במערכת` },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === 'contact_not_found') {
      return NextResponse.json({ error: 'הדירה לא נמצאה במרשם' }, { status: 404 });
    }
    if (err instanceof Error && err.message === 'invalid_chip_number') {
      return NextResponse.json({ error: 'נדרש מספר צ׳יפ' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'holder_name_required') {
      return NextResponse.json({ error: 'לבעל צ׳יפ מסוג "אחר" נדרש שם מלא' }, { status: 400 });
    }
    const e = err as { code?: string };
    if (e.code === '23503') {
      return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    }
    if (e.code === '23514') {
      return NextResponse.json({ error: 'invalid_value' }, { status: 400 });
    }
    logger.error('[PATCH /api/chips/:id]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

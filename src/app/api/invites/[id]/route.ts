import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query, queryOne } from '@/lib/db';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireSuperAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const exists = await queryOne<{ id: string; accepted_at: string | null }>(
    `select id, accepted_at from public.user_invites where id = $1 limit 1`,
    [id],
  );
  if (!exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (exists.accepted_at) {
    return NextResponse.json({ error: 'ההזמנה כבר נוצלה' }, { status: 409 });
  }

  await query(`delete from public.user_invites where id = $1`, [id]);
  return NextResponse.json({ ok: true });
}

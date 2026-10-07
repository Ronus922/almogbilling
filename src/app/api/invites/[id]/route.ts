import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { query, queryOne } from '@/lib/db';
import { canManageRole } from '@/lib/permissions/check';
import type { Role } from '@/lib/permissions/constants';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * DELETE /api/invites/[id] — cancel an open invite. super_admin: any invite;
 * admin: only an invite to a role they may manage (canManageRole — the same
 * scope as creating it, decision 07/10/2026); anyone else: 403.
 */
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const exists = await queryOne<{ id: string; role: Role; accepted_at: string | null }>(
    `select id, role, accepted_at from public.user_invites where id = $1 limit 1`,
    [id],
  );
  if (!exists) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!canManageRole(actor.role, exists.role)) {
    return NextResponse.json({ error: 'אין הרשאה לנהל הזמנה לתפקיד זה' }, { status: 403 });
  }
  if (exists.accepted_at) {
    return NextResponse.json({ error: 'ההזמנה כבר נוצלה' }, { status: 409 });
  }

  await query(`delete from public.user_invites where id = $1`, [id]);
  return NextResponse.json({ ok: true });
}

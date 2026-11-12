import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markChipOrderCollected } from '@/lib/db/chipOrders';
import { writeAudit } from '@/lib/db/audit';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/collected (chips_orders_manage:edit) — "נאסף".
// No message to the orderer (the four messages are received / approved /
// ready / rejected).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips_orders_manage', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  try {
    const ok = await markChipOrderCollected(id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    after(() => writeAudit({ actorUserId: actor.id, action: 'collected', entityType: 'chip_order', entityId: id }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/collected');
  }
}

import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markChipOrderReady } from '@/lib/db/chipOrders';
import { writeAudit } from '@/lib/db/audit';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/ready (chips_orders_manage:edit) — "מוכן לאיסוף",
// only once every apartment line has all its chips issued (chips.order_item_id).
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
    const ok = await markChipOrderReady(id);
    if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    after(async () => {
      await writeAudit({ actorUserId: actor.id, action: 'ready', entityType: 'chip_order', entityId: id });
      await notifyChipOrder(id, 'ready');
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/ready');
  }
}

import { NextResponse } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCancelBodySchema } from '@/lib/validation/requests';
import { cancelReceptionOrder } from '@/lib/db/chipOrders';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/cancel — "בטל הזמנת קבלה" (25/11/2026). ADMIN AND
// SUPER ADMIN ONLY, by role (requireAdmin): a reception order records money
// that was received, so undoing one is not part of issuing chips — a manager
// who may record a payment at the reception may not cancel it.
//
// Only a RECEPTION order (cash or transfer) that is still collected: it is
// stored `rejected` with the required reason, every active chip of it is
// disabled (never deleted), no message goes to the customer, and the audit row
// is written in the same transaction (cancelReceptionOrder). A web order is
// refused here — it is rejected through "דחה", which also refunds it.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderCancelBodySchema);
  if (!body.ok) return body.response;
  try {
    const done = await cancelReceptionOrder(id, body.data.reason, { id: actor.id, name: actor.full_name ?? actor.username });
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, chips_disabled: done.chips_disabled });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/cancel');
  }
}

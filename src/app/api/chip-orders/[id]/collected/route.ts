import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseOptionalJsonBody } from '@/lib/http/body';
import { chipOrderCollectedBodySchema } from '@/lib/validation/requests';
import { markChipOrderCollected } from '@/lib/db/chipOrders';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/collected (chips_orders_manage:edit) — "נאסף" of
// the management (the orders table and the issue window). No message to the
// orderer. From 25/11/2026 the body MAY name the person of the order who
// collected ({ person } — a holder line id, or the orderer of an old order);
// a bare POST, as before, names nobody. Who marked the order, and that person
// when named, are stored on the order and audited in the same transaction
// (markChipOrderCollected — the function the guard's pickup screen uses too).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  const body = await parseOptionalJsonBody(req, chipOrderCollectedBodySchema);
  if (!body.ok) return body.response;
  try {
    const done = await markChipOrderCollected(
      id,
      { id: actor.id, name: actor.full_name ?? actor.username },
      { via: 'management', collector: body.data.person ?? null, deliveryNote: body.data.delivery_note ?? null },
    );
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/collected');
  }
}

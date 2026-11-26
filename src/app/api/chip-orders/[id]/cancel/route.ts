import { NextResponse, after } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCancelBodySchema } from '@/lib/validation/requests';
import { cancelReceptionOrder } from '@/lib/db/chipOrders';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { refundCardOrder } from '@/lib/chipOrders/refund';
import { processDueDocuments } from '@/lib/chipOrders/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/cancel — "בטל הזמנת קבלה" (25/11/2026). ADMIN AND
// SUPER ADMIN ONLY, by role (requireAdmin): a reception order records money
// that was received, so undoing one is not part of issuing chips — a manager
// who may record a payment at the reception may not cancel it.
//
// Only a RECEPTION order that is still collected (or, 26/11/2026, one a card
// PAID whose chips were never issued): it is stored `rejected` with the
// required reason, every active chip of it is disabled (never deleted), no
// message goes to the customer, and the audit row is written in the same
// transaction (cancelReceptionOrder). The money (26/11/2026):
//   - paid by CARD → refunded through PayPlus right after (refundCardOrder —
//     in the sandbox for a test order), with its Morning credit document;
//   - cash / bank transfer → returned by hand (the dialog says so); the
//     order's Morning document is credited in the same transaction.
// A web order is refused here — it is rejected through "דחה", or refunded
// with "זיכוי".
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
    const by = { id: actor.id, name: actor.full_name ?? actor.username };
    const done = await cancelReceptionOrder(id, body.data.reason, by);
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    let refund: Awaited<ReturnType<typeof refundCardOrder>> = null;
    if (done.card_paid) {
      refund = await refundCardOrder(id, {
        via: 'reception_cancel', reason: body.data.reason, by,
        statuses: ['rejected'], sources: ['reception'], closeOpen: false, disableChips: false,
      }).catch(() => ({ kind: 'manual_required' as const, note: 'הזיכוי לא נשלח ל-PayPlus — נדרש זיכוי ידני' }));
    }
    after(() => processDueDocuments().then(() => undefined));
    return NextResponse.json({ ok: true, chips_disabled: done.chips_disabled, payment_method: done.payment_method, refund });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/cancel');
  }
}

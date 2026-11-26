import { NextResponse, after } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderRefundBodySchema } from '@/lib/validation/requests';
import { refundCardOrder } from '@/lib/chipOrders/refund';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/refund — "זיכוי" (26/11/2026). ADMIN AND SUPER
// ADMIN ONLY, by role (requireAdmin), with a required reason (the window asks
// for it and for a confirmation). A WEB order paid by card, in any status but
// already refunded: a FULL refund through PayPlus (refundCardOrder) — then, in
// one transaction, the order is marked refunded (an order not collected yet is
// closed as rejected with the reason), its active chips are disabled, the
// Morning credit document is queued (never for a test order — that refund goes
// to the sandbox), and the audit row is written. The customer is told after
// the answer. PayPlus refusing, or not answering, is recorded on the order and
// answered here — the money is then returned by hand in PayPlus.
// Also a RECEPTION card order that was CANCELLED ("בטל הזמנת קבלה") and whose
// refund did not go through then — the same refund, with its credit document
// (beginRefund refuses a reception order that was not cancelled).
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
  const body = await parseJsonBody(req, chipOrderRefundBodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await refundCardOrder(id, {
      via: 'admin',
      reason: body.data.reason,
      by: { id: actor.id, name: actor.full_name ?? actor.username },
      statuses: ['paid', 'approved', 'ready', 'collected', 'rejected'],
      sources: ['web', 'reception'],
      closeOpen: true,
      disableChips: true,
    });
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (result.kind === 'refunded') {
      const chipsDisabled = result.chipsDisabled;
      after(async () => {
        await processDueDocuments();
        await notifyChipOrder(id, 'refunded', { chipsDisabled });
      });
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ ok: false, ...result, error: result.note }, { status: 502 });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/refund');
  }
}

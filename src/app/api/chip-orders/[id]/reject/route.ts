import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderRejectBodySchema } from '@/lib/validation/requests';
import { rejectChipOrder, setChipOrderRefund } from '@/lib/db/chipOrders';
import { writeAudit } from '@/lib/db/audit';
import { isGrowConfigured, refundTransaction } from '@/lib/grow/client';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { CHIP_ORDER_REFUND_LABEL } from '@/lib/chipOrders/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/reject (chips_orders_manage:edit) — "דחה" with a
// reason. The status changes first (committed), then a FULL refund is asked of
// Grow (refundTransaction, R/refund-transaction). Grow answering anything but
// success — e.g. 110 "already paid out, waiting for Grow's approval", no
// balance, refunds not enabled — leaves refund_status = manual_required with
// Grow's own message, shown on the order. The rejection message (email +
// WhatsApp) goes out after the refund outcome is known, so it states it.
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
  const body = await parseJsonBody(req, chipOrderRejectBodySchema);
  if (!body.ok) return body.response;

  let rejected;
  try {
    rejected = await rejectChipOrder(id, body.data.reason);
    if (!rejected) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/reject');
  }

  let refund: { status: 'refunded' | 'manual_required'; note: string | null };
  if (!rejected.grow_transaction_id || !rejected.grow_transaction_token || !isGrowConfigured()) {
    refund = { status: 'manual_required', note: 'אין פרטי עסקה של Grow להזמנה — נדרש זיכוי ידני' };
  } else {
    const r = await refundTransaction({
      transactionId: rejected.grow_transaction_id,
      transactionToken: rejected.grow_transaction_token,
      refundSum: rejected.total,
    });
    refund = r.kind === 'refunded'
      ? { status: 'refunded', note: null }
      : { status: 'manual_required', note: `Grow${r.code !== null ? ` ${r.code}` : ''}: ${r.message}` };
  }
  try {
    await setChipOrderRefund(id, refund.status, refund.note);
  } catch (err) {
    // The rejection is committed and Grow has answered — losing the record must
    // not hide that outcome from the person who pressed the button.
    logger.error('[chip-orders] refund outcome not recorded', { orderId: id, refund, err });
  }

  after(async () => {
    await writeAudit({
      actorUserId: actor.id,
      action: 'rejected',
      entityType: 'chip_order',
      entityId: id,
      metadata: { reason: body.data.reason, refund_status: refund.status, refund_note: refund.note },
    });
    await notifyChipOrder(id, 'rejected');
  });
  return NextResponse.json({ ok: true, refund_status: refund.status, refund_label: CHIP_ORDER_REFUND_LABEL[refund.status], refund_note: refund.note });
}

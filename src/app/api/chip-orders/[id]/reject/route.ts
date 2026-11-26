import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderRejectBodySchema } from '@/lib/validation/requests';
import { ChipOrderStateError, rejectChipOrder, setChipOrderRefund } from '@/lib/db/chipOrders';
import { queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { refundCardOrder } from '@/lib/chipOrders/refund';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { CHIP_ORDER_REFUND_LABEL, type ChipOrderRefundStatus } from '@/lib/chipOrders/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/reject (chips_orders_manage:edit) — "דחה" with a
// reason. The status changes first (committed); then the refund:
//   - paid BY CARD → a full refund through PayPlus (refundCardOrder, in the
//     order's environment: a test order is refunded in the sandbox), recorded
//     with its Morning credit document (never for a test order);
//   - a test order that was never charged → not_required ("לא נדרש (בדיקה)");
//   - anything else → manual_required (returned by hand).
// The rejection message (email + WhatsApp) goes out after the outcome is
// known, so it states it.
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

  let refund: { status: ChipOrderRefundStatus; note: string | null };
  if (rejected.card_status === 'paid') {
    try {
      const r = await refundCardOrder(id, {
        via: 'reject', reason: body.data.reason, by: { id: actor.id, name: actor.full_name ?? actor.username },
        statuses: ['rejected'], closeOpen: false, disableChips: false,
      });
      refund = r?.kind === 'refunded'
        ? { status: r.full ? 'refunded' : 'partial', note: null }
        : { status: 'manual_required', note: r?.note ?? 'הזיכוי לא בוצע' };
    } catch (err) {
      if (err instanceof ChipOrderStateError && err.message === 'already_refunded') {
        // Refunded before (e.g. in the PayPlus dashboard, maybe partly): the
        // refund on record stays as it is — never overwritten here.
        const current = await queryOne<{ refund_status: ChipOrderRefundStatus | null }>(
          `select refund_status from public.chip_orders where id = $1`, [id],
        );
        refund = current?.refund_status === 'partial'
          ? { status: 'partial', note: 'זוכה חלקית ב-PayPlus — את היתרה יש לזכות ידנית' }
          : { status: current?.refund_status ?? 'refunded', note: null };
        if (refund.status === 'partial') await setChipOrderRefund(id, 'partial', refund.note).catch(() => {});
      } else if (err instanceof ChipOrderStateError && err.message === 'refund_in_progress') {
        // An earlier "זיכוי" is still waiting for PayPlus's answer — it may have
        // gone through. Never claim it was not sent.
        refund = { status: 'manual_required', note: 'בקשת זיכוי קודמת ממתינה לתשובה מ-PayPlus — יש לבדוק ב-PayPlus לפני כל זיכוי נוסף' };
        await setChipOrderRefund(id, refund.status, refund.note).catch(() => {});
      } else {
        logger.error('[chip-orders] reject: refund failed to start', { orderId: id, err });
        refund = { status: 'manual_required', note: 'הזיכוי לא נשלח ל-PayPlus — נדרש זיכוי ידני' };
        await setChipOrderRefund(id, refund.status, refund.note).catch(() => {});
      }
    }
  } else {
    refund = rejected.is_test
      ? { status: 'not_required', note: null }
      : { status: 'manual_required', note: 'ההזמנה לא שולמה בכרטיס דרך המערכת — נדרש זיכוי ידני' };
    try {
      await setChipOrderRefund(id, refund.status, refund.note);
    } catch (err) {
      // The rejection is committed — losing the record must not hide the
      // outcome from the person who pressed the button.
      logger.error('[chip-orders] refund outcome not recorded', { orderId: id, refund, err });
    }
  }

  after(async () => {
    await writeAudit({
      actorUserId: actor.id,
      action: 'rejected',
      entityType: 'chip_order',
      entityId: id,
      metadata: { reason: body.data.reason, refund_status: refund.status, refund_note: refund.note },
    });
    await processDueDocuments();
    await notifyChipOrder(id, 'rejected');
  });
  return NextResponse.json({ ok: true, refund_status: refund.status, refund_label: CHIP_ORDER_REFUND_LABEL[refund.status], refund_note: refund.note });
}

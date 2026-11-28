import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { isElevatedRole } from '@/lib/permissions/constants';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderRejectBodySchema } from '@/lib/validation/requests';
import { ChipOrderStateError, rejectChipOrder, setChipOrderRefund } from '@/lib/db/chipOrders';
import { queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { runCancelAndCredit } from '@/lib/chipOrders/receptionCancel';
import { RECEPTION_CANCEL_STEP_LABEL, type ReceptionCancelStep } from '@/lib/chipOrders/receptionCancelText';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { CHIP_ORDER_REFUND_LABEL, type ChipOrderRefundStatus } from '@/lib/chipOrders/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/reject (chips_orders_manage:edit) — "דחה" with a
// reason. An order that took money — every real order: the tab shows paid
// orders only — is rejected by an ADMIN or SUPER ADMIN only, by role (F3,
// Ronen 27/11/2026): the rejection refunds it, exactly like "ביטול וזיכוי".
// Anyone else may reject a TEST order that was never charged (403
// refund_admin_only otherwise, checked on the locked order — nothing changes).
// The status changes first (committed); then the money:
//   - paid BY CARD → the steps of "ביטול וזיכוי" (runCancelAndCredit, 27/11/2026
//     — the one refund of the module: PayPlus is asked first, a refund is never
//     sent twice): the refund, the Morning credit document (never for a test
//     order), the order's chips disabled. A step that fails is stored on the
//     order and shown there; an admin finishes it with "המשך ביטול וזיכוי";
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
    rejected = await rejectChipOrder(id, body.data.reason, { mayRefund: isElevatedRole(actor.role) });
    if (!rejected) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/reject');
  }

  let refund: { status: ChipOrderRefundStatus; note: string | null };
  let stopped: { step: ReceptionCancelStep; message: string | null } | null = null;
  if (rejected.card_status === 'paid') {
    // Another run holds the order right now (an admin's "ביטול וזיכוי"):
    // that run does the refund — nothing is written here, never a second one.
    let elsewhere = false;
    try {
      const run = await runCancelAndCredit(id, body.data.reason, { id: actor.id, name: actor.full_name ?? actor.username }, 'reject');
      if (run && run.kind === 'failed' && run.failedStep) stopped = { step: run.failedStep, message: run.message };
    } catch (err) {
      if (err instanceof ChipOrderStateError && err.message === 'cancel_in_progress') {
        elsewhere = true;
      } else {
        logger.error('[chip-orders] reject: the refund steps failed to start', { orderId: id, err });
        stopped = { step: 'refund', message: 'הזיכוי לא נשלח — בדקו את מצב ההזמנה לפני כל ניסיון נוסף' };
      }
    }
    // What the order records now — the refund step's own words when it failed.
    const now = await queryOne<{ refund_status: ChipOrderRefundStatus | null; refund_note: string | null }>(
      `select refund_status, refund_note from public.chip_orders where id = $1`, [id],
    );
    if (elsewhere) {
      refund = { status: now?.refund_status ?? 'manual_required', note: '„ביטול וזיכוי” רץ כרגע על ההזמנה — מצב הזיכוי יתעדכן בסופו' };
    } else {
      refund = now?.refund_status === 'refunded' || now?.refund_status === 'partial'
        ? { status: now.refund_status, note: stopped ? `${RECEPTION_CANCEL_STEP_LABEL[stopped.step]} — ${stopped.message ?? 'נעצר'}` : null }
        : { status: 'manual_required', note: stopped?.message ?? now?.refund_note ?? 'הזיכוי לא בוצע' };
      // Never over a refund recorded meanwhile (setChipOrderRefund checks it).
      if (now?.refund_status !== 'refunded' && now?.refund_status !== 'partial') {
        await setChipOrderRefund(id, 'manual_required', refund.note).catch(() => {});
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
  return NextResponse.json({
    ok: true, refund_status: refund.status, refund_label: CHIP_ORDER_REFUND_LABEL[refund.status], refund_note: refund.note,
    failed_step: stopped?.step ?? null,
  });
}

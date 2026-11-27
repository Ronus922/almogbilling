import 'server-only';
import { query, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { enqueueDocumentInTx, getInvoiceRowOfOrderInTx } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import type { ChipOrderStatus } from '@/lib/chipOrders/model';

// Chip orders — refunds of card payments (migration 20261125223806). The ONE
// place a refund is recorded is recordRefund below, and it is only called with
// what PayPlus itself answered or shows: the refund API's reply, or — asked
// before any refund is sent — a cancellation / refund PayPlus already holds
// (src/lib/chipOrders/refund.ts, refundCharge: the one refund of the module).
//
// ONE REFUND CALL PER ORDER, EVER, while its answer is missing: refundCharge
// marks the order (refund_requested_at) right before the call, and never calls
// again while that mark stands — a definite refusal clears it
// (recordRefundFailure); a call with no answer keeps it until PayPlus shows
// the refund (27/11/2026: the ten-minute window after which "זיכוי" used to
// send a second refund is gone). PayPlus documents no idempotency for refunds,
// so the guard is ours.

export type RefundVia = 'admin' | 'reject' | 'reception_cancel' | 'payplus';

/** The refund call's own lifetime: PayPlus's 20-second timeout
 *  (src/lib/payplus/client.ts) with a margin — while it runs, its own answer
 *  records the refund. */
export const REFUND_CALL_SECONDS = 30;

/** The order as the refund needs it (read under the run's lease). */
export interface RefundTarget {
  id: string;
  order_number: number;
  is_test: boolean;
  total: number;
  card_env: 'sandbox' | 'production' | null;
  card_transaction_uid: string | null;
  card_page_request_uid: string | null;
  card_paid_amount: number | null;
  refunded_at: string | null;
  refunded_amount: number | null;
  refund_via: string | null;
  /** A refund call was sent and its answer is not recorded (null after a
   *  definite refusal — recordRefundFailure clears it). */
  refund_requested_at: string | null;
  /** …less than REFUND_CALL_SECONDS ago: it may still be answered. */
  refund_call_running: boolean;
  /** The reason the action was started with. */
  reason: string;
}


export interface RecordRefund {
  refundUid: string;
  amount: number;
  via: RefundVia;
  by: { id: string; name: string } | null;
  reason: string | null;
  /** Kept on the order as refund_note (27/11/2026): a refund made in PayPlus
   *  directly, found before "ביטול וזיכוי" — the order says so. */
  note?: string | null;
}

export type RecordedRefund =
  | { kind: 'recorded'; full: boolean; orderNumber: number }
  /** The same refund again — nothing changed. */
  | { kind: 'already' }
  /** More than was charged, or not a card-paid order — nothing changed. */
  | { kind: 'refused'; why: string };

/**
 * A refund PayPlus confirmed (or shows) → the order's refund, the credit
 * document and the audit row, in ONE transaction. Idempotent per refund id. A second,
 * different refund adds to the amount refunded (a refund of part of the charge
 * made in the PayPlus dashboard, then another).
 */
export async function recordRefund(orderId: string, r: RecordRefund): Promise<RecordedRefund> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<{
        order_number: number; status: ChipOrderStatus; is_test: boolean; card_env: string | null; card_status: string | null;
        card_paid_amount: number | null; refunded_amount: number | null; refund_transaction_uid: string | null;
      }>(
        `select order_number, status, is_test, card_env, card_status, card_paid_amount::float8 as card_paid_amount,
                refunded_amount::float8 as refunded_amount, refund_transaction_uid
           from public.chip_orders where id = $1 for update`,
        [orderId],
      )
    ).rows[0];
    if (!o || o.card_status !== 'paid' || o.card_paid_amount === null) return { kind: 'refused', why: 'not_card_paid' } as const;
    if (o.refund_transaction_uid === r.refundUid) return { kind: 'already' } as const;
    // Recorded before: a credit document keyed by this refund (real orders), or
    // this order's 'refunded' audit row naming it (any order — a TEST order has
    // no document, and refund_transaction_uid keeps only the FIRST refund's id).
    const seen = (
      await client.query(
        `select 1 from public.chip_order_documents where payment_key = $1
         union all
         select 1 from public.audit_log
          where entity_type = 'chip_order' and entity_id = $2 and action = 'refunded' and metadata->>'refund_uid' = $3
         limit 1`,
        [`refund:${r.refundUid}`, orderId, r.refundUid],
      )
    ).rowCount ?? 0;
    if (seen > 0) return { kind: 'already' } as const;
    const before = o.refunded_amount ?? 0;
    const after = Math.round((before + r.amount) * 100) / 100;
    if (r.amount <= 0 || after > o.card_paid_amount + 0.001) return { kind: 'refused', why: 'amount' } as const;
    const full = Math.round(after * 100) === Math.round(o.card_paid_amount * 100);
    // The order's status and its chips are not this function's (27/11/2026):
    // the last step of "ביטול וזיכוי" closes the order and disables them.
    await client.query(
      `update public.chip_orders
          set refund_requested_at = null,
              refunded_at = coalesce(refunded_at, now()),
              refunded_amount = $2,
              refund_transaction_uid = coalesce(refund_transaction_uid, $3),
              refund_status = $4, refund_note = $9,
              refund_via = coalesce(refund_via, $5),
              refunded_by = coalesce(refunded_by, $6), refunded_by_name = coalesce(refunded_by_name, $7),
              refund_reason = coalesce(refund_reason, $8),
              updated_at = now()
        where id = $1`,
      [orderId, after, r.refundUid, full ? 'refunded' : 'partial', r.via, r.by?.id ?? null, r.by?.name?.slice(0, 120) ?? null,
        r.reason, r.note?.slice(0, 500) ?? null],
    );
    // The credit document (never for a test order — enqueueDocumentInTx refuses it).
    if (o.card_env === 'production' && !o.is_test) {
      const invoice = await getInvoiceRowOfOrderInTx(client, orderId);
      await enqueueDocumentInTx(client, {
        orderId,
        kind: 'credit',
        paymentKey: `refund:${r.refundUid}`,
        amount: r.amount,
        method: 'card',
        details: { date: israelDate(), refund_uid: r.refundUid, via: r.via },
        creditOf: invoice?.id ?? null,
      });
    }
    await writeAuditInTx(client, {
      actorUserId: r.by?.id ?? null,
      action: 'refunded',
      entityType: 'chip_order',
      entityId: orderId,
      metadata: {
        via: r.via, refund_uid: r.refundUid, amount: r.amount, total_refunded: after, full,
        reason: r.reason, env: o.card_env,
        ...(r.note ? { note: r.note } : {}),
      },
    });
    return { kind: 'recorded', full, orderNumber: o.order_number } as const;
  });
}

/** The refund did not go through (or its outcome is unknown): the order says
 *  so — manual_required with the processor's words. `stillInFlight` keeps the
 *  in-flight mark (an unknown outcome: a person checks PayPlus first). */
export async function recordRefundFailure(orderId: string, note: string, stillInFlight: boolean): Promise<void> {
  await query(
    `update public.chip_orders
        set refund_status = case when refunded_at is null then 'manual_required' else refund_status end,
            refund_note = $2,
            refund_requested_at = case when $3::boolean then refund_requested_at else null end,
            updated_at = now()
      where id = $1`,
    [orderId, note.slice(0, 300), stillInFlight],
  );
}

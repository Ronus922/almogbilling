import 'server-only';
import { query, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { deactivateChipInTx } from '@/lib/db/chips';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { enqueueDocumentInTx, getInvoiceRowOfOrderInTx } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import type { ChipOrderStatus } from '@/lib/chipOrders/model';

// Chip orders — refunds of card payments (migration 20261125223806). The ONE
// place a refund is recorded is recordRefund below, and it is only called with
// what PayPlus itself answered (the refund API's reply, or a refund PayPlus
// reported in a validated callback).
//
// ONE REFUND IN FLIGHT PER ORDER: beginRefund marks the order (row lock +
// refund_requested_at) before the processor is called, and refuses a second
// "זיכוי" while one is in flight or after the order was refunded — PayPlus
// documents no idempotency for refunds, so the guard is ours.

/** A refund older than this with no recorded answer is treated as unknown: a
 *  person checks PayPlus (the dashboard refund callback resolves it as well). */
const IN_FLIGHT_MINUTES = 10;

export interface RefundableOrder {
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  source: string;
  is_test: boolean;
  total: number;
  card_env: 'sandbox' | 'production' | null;
  card_transaction_uid: string;
  card_paid_amount: number;
}

/**
 * Locks the order and marks a refund as in flight. Only an order of one of
 * `sources`, paid BY CARD (the processor confirmed a charge), not refunded
 * yet, with no refund in flight, in one of `statuses`. A RECEPTION order only
 * once it was cancelled (rejected): "בטל הזמנת קבלה" disables its chips and
 * refunds it, and when that refund failed it is refunded again here — an open
 * or collected reception order is never refunded around the cancel. Throws
 * ChipOrderStateError: not_web_order, not_card_paid, already_refunded,
 * refund_in_progress, not_refundable. Null = no such order.
 */
export async function beginRefund(
  orderId: string,
  statuses: readonly ChipOrderStatus[],
  sources: readonly string[] = ['web'],
): Promise<RefundableOrder | null> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<RefundableOrder & { card_status: string | null; refunded_at: string | null; refund_requested_at: string | null; in_flight: boolean }>(
        `select id, order_number, status, source, is_test, total::float8 as total, card_env, card_status,
                card_transaction_uid, card_paid_amount::float8 as card_paid_amount, refunded_at, refund_requested_at,
                (refund_requested_at is not null and refund_requested_at > now() - make_interval(mins => $2)) as in_flight
           from public.chip_orders where id = $1 for update`,
        [orderId, IN_FLIGHT_MINUTES],
      )
    ).rows[0];
    if (!o) return null;
    if (!sources.includes(o.source)) throw new ChipOrderStateError('not_web_order');
    if (o.source === 'reception' && o.status !== 'rejected') throw new ChipOrderStateError('not_web_order');
    if (o.card_status !== 'paid' || !o.card_transaction_uid || o.card_paid_amount === null) throw new ChipOrderStateError('not_card_paid');
    if (o.refunded_at) throw new ChipOrderStateError('already_refunded');
    if (o.in_flight) throw new ChipOrderStateError('refund_in_progress');
    if (!statuses.includes(o.status)) throw new ChipOrderStateError('not_refundable');
    await client.query(`update public.chip_orders set refund_requested_at = now(), updated_at = now() where id = $1`, [orderId]);
    return o;
  });
}

export type RefundVia = 'admin' | 'reject' | 'reception_cancel' | 'payplus';

export interface RecordRefund {
  refundUid: string;
  amount: number;
  via: RefundVia;
  by: { id: string; name: string } | null;
  reason: string | null;
  /** An order still open (paid / ready) is closed as rejected, with the reason. */
  closeOpen: boolean;
  /** Its active chips are disabled (needs `by`). */
  disableChips: boolean;
}

export type RecordedRefund =
  | { kind: 'recorded'; chipsDisabled: number; full: boolean; closed: boolean; orderNumber: number }
  /** The same refund again — nothing changed. */
  | { kind: 'already' }
  /** More than was charged, or not a card-paid order — nothing changed. */
  | { kind: 'refused'; why: string };

/**
 * A refund PayPlus confirmed → the order, its chips, the credit document and
 * the audit row, in ONE transaction. Idempotent per refund id. A second,
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
    const open = o.status === 'paid' || o.status === 'approved' || o.status === 'ready';
    const close = r.closeOpen && open && full;

    let chipsDisabled = 0;
    if (r.disableChips && r.by) {
      const active = (
        await client.query<{ id: string; moved: boolean }>(
          `select c.id, (c.contact_id is distinct from i.contact_id) as moved
             from public.chips c
             join public.chip_order_items i on i.id = c.order_item_id
            where i.order_id = $1 and c.status = 'active'
            order by c.issued_at, c.id
            for update of c`,
          [orderId],
        )
      ).rows.filter((c) => !c.moved);
      for (const c of active) {
        await deactivateChipInTx(client, c.id, { reason: 'unknown', note: `זיכוי הזמנה ${o.order_number}` }, r.by);
      }
      chipsDisabled = active.length;
    }

    await client.query(
      `update public.chip_orders
          set refund_requested_at = null,
              refunded_at = coalesce(refunded_at, now()),
              refunded_amount = $2,
              refund_transaction_uid = coalesce(refund_transaction_uid, $3),
              refund_status = $4, refund_note = null,
              refund_via = coalesce(refund_via, $5),
              refunded_by = coalesce(refunded_by, $6), refunded_by_name = coalesce(refunded_by_name, $7),
              refund_reason = coalesce(refund_reason, $8),
              status = case when $9::boolean then 'rejected' else status end,
              rejected_at = case when $9::boolean then now() else rejected_at end,
              reject_reason = case when $9::boolean then coalesce(reject_reason, $8, 'זיכוי') else reject_reason end,
              updated_at = now()
        where id = $1`,
      [orderId, after, r.refundUid, full ? 'refunded' : 'partial', r.via, r.by?.id ?? null, r.by?.name?.slice(0, 120) ?? null,
        r.reason, close],
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
        via: r.via, refund_uid: r.refundUid, amount: r.amount, total_refunded: after, full, closed: close,
        chips_disabled: chipsDisabled, reason: r.reason, env: o.card_env,
      },
    });
    return { kind: 'recorded', chipsDisabled, full, closed: close, orderNumber: o.order_number } as const;
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

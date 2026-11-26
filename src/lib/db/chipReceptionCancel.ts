import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { enqueueDocumentInTx, getInvoiceRowOfOrderInTx, type DocStatus } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import type { ChipOrderStatus } from '@/lib/chipOrders/model';
import type { ReceptionCancelPreviewView, ReceptionCancelStep } from '@/lib/chipOrders/receptionCancelText';

// "ביטול וזיכוי" of a reception order (27/11/2026) — the state of its steps on
// the order (migration 20261126220000). The steps themselves run in
// src/lib/chipOrders/receptionCancel.ts, in this order: the refund in PayPlus
// (a card), the credit document in Morning, the cancellation (the order
// `rejected`, its chips disabled — cancelReceptionOrder, one transaction).
// A failed step is stored with its words; a retry starts again at the first
// step that is not done — and a refund that went through is never sent again.

export type CancelStep = ReceptionCancelStep;

/** One run at a time per order: the lease beginReceptionCancel takes —
 *  longer than the slowest run (every PayPlus / Morning call waits up to 20
 *  seconds); a run that crashed holds the order this long at most. */
const RUN_LEASE_SECONDS = 300;
/** Our own refund call may still wait for PayPlus (its 20-second timeout,
 *  with a margin) — the same window refund.ts honours. */
const REFUND_CALL_SECONDS = 30;

export interface CancelTarget {
  id: string;
  order_number: number;
  status: ChipOrderStatus;
  is_test: boolean;
  total: number;
  payment_method: string | null;
  card_status: string | null;
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
  /** This run's lease (its end, as stored): only this run lets it go. */
  lease: string;
}

/**
 * Starts (or resumes) "ביטול וזיכוי": the order locked, checked, marked as
 * requested — who, when, why — with its last failure cleared and a two-minute
 * lease taken. Only a RECEPTION order that is collected, or one a card paid
 * whose chips were never saved (the window was closed after the payment); a
 * cancelled one is refused. `reason` is required the first time; a retry
 * keeps the first one. Null = no such order.
 */
export async function beginReceptionCancel(
  orderId: string,
  reason: string | null,
  by: { id: string; name: string },
): Promise<CancelTarget | null> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<CancelTarget & { source: string; cancel_requested_at: string | null; running: boolean; cancel_request_reason: string | null }>(
        `select id, order_number, status, source, is_test, total::float8 as total, payment_method, card_status, card_env,
                card_transaction_uid, card_page_request_uid, card_paid_amount::float8 as card_paid_amount, refunded_at,
                refunded_amount::float8 as refunded_amount, refund_via, refund_requested_at,
                (refund_requested_at is not null and refund_requested_at > now() - make_interval(secs => $2)) as refund_call_running,
                cancel_requested_at, cancel_request_reason,
                (cancel_running_until is not null and cancel_running_until > now()) as running
           from public.chip_orders where id = $1 for update`,
        [orderId, REFUND_CALL_SECONDS],
      )
    ).rows[0];
    if (!o) return null;
    if (o.source !== 'reception') throw new ChipOrderStateError('not_reception');
    if (o.status === 'rejected') throw new ChipOrderStateError('already_cancelled');
    const paidByCardNoChips = o.status === 'paid' && o.payment_method === 'card' && o.card_status === 'paid';
    if (o.status !== 'collected' && !paidByCardNoChips) throw new ChipOrderStateError('not_cancellable');
    if (o.running) throw new ChipOrderStateError('cancel_in_progress');
    const why = o.cancel_request_reason ?? reason?.trim() ?? '';
    if (why.length < 2) throw new ChipOrderStateError('reason_required');
    const lease = (
      await client.query<{ lease: string }>(
        `update public.chip_orders
            set cancel_requested_at = coalesce(cancel_requested_at, now()),
                cancel_requested_by = case when cancel_requested_at is null then $2 else cancel_requested_by end,
                cancel_requested_by_name = coalesce(cancel_requested_by_name, $3),
                cancel_request_reason = coalesce(cancel_request_reason, $4),
                cancel_failed_step = null, cancel_error = null,
                cancel_running_until = clock_timestamp() + make_interval(secs => $5), updated_at = now()
          where id = $1
          returning cancel_running_until::text as lease`,
        [orderId, by.id, by.name.slice(0, 120), why.slice(0, 500), RUN_LEASE_SECONDS],
      )
    ).rows[0]!.lease;
    if (!o.cancel_requested_at) {
      await writeAuditInTx(client, {
        actorUserId: by.id,
        action: 'reception_cancel_started',
        entityType: 'chip_order',
        entityId: orderId,
        metadata: { order_number: o.order_number, reason: why, amount: o.total, payment_method: o.payment_method },
      });
    }
    return {
      id: o.id, order_number: o.order_number, status: o.status, is_test: o.is_test, total: o.total,
      payment_method: o.payment_method, card_status: o.card_status, card_env: o.card_env,
      card_transaction_uid: o.card_transaction_uid, card_page_request_uid: o.card_page_request_uid, card_paid_amount: o.card_paid_amount,
      refunded_at: o.refunded_at, refunded_amount: o.refunded_amount, refund_via: o.refund_via,
      refund_requested_at: o.refund_requested_at, refund_call_running: o.refund_call_running, reason: why, lease,
    };
  });
}

/** A step failed: the order says which, in these words; the lease — when it
 *  is still this run's — is let go so "נסה שוב" may run at once. Audited (who
 *  ran it, which step, why). */
export async function failReceptionCancel(
  orderId: string, step: CancelStep, message: string, by: { id: string; name: string }, lease: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const r = await client.query<{ order_number: number }>(
      `update public.chip_orders
          set cancel_failed_step = $2, cancel_error = $3,
              cancel_running_until = case when cancel_running_until = $4::timestamptz then null else cancel_running_until end,
              updated_at = now()
        where id = $1 and status <> 'rejected' and cancel_requested_at is not null
        returning order_number`,
      [orderId, step, message.trim().slice(0, 500) || 'השלב נכשל', lease],
    );
    if (r.rows[0]) {
      await writeAuditInTx(client, {
        actorUserId: by.id,
        action: 'reception_cancel_failed',
        entityType: 'chip_order',
        entityId: orderId,
        metadata: { order_number: r.rows[0].order_number, step, message: message.slice(0, 500) },
      });
    }
  });
}

/** Marks the refund call as sent, right before it is made — only when no
 *  earlier call is unanswered and the order was not refunded. False = refuse
 *  to call (another call is out, or the order was refunded meanwhile). */
export async function markReceptionRefundRequested(orderId: string): Promise<boolean> {
  const r = await query(
    `update public.chip_orders set refund_requested_at = now(), updated_at = now()
      where id = $1 and refunded_at is null and refund_requested_at is null and card_status = 'paid'`,
    [orderId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Cash / a bank transfer: the credit document of the order's invoice, queued
 *  (the money goes back by hand). Idempotent — the same key as the final step
 *  uses (`cancel:<order>`). False when the order has no invoice (recorded
 *  before 26/11/2026 as "מזומן או העברה") or is a test order. */
export async function queueReceptionCancelCredit(orderId: string, method: 'cash' | 'bank_transfer', amount: number, byName: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const invoice = await getInvoiceRowOfOrderInTx(client, orderId);
    if (!invoice) return false;
    await enqueueDocumentInTx(client, {
      orderId,
      kind: 'credit',
      paymentKey: `cancel:${orderId}`,
      amount,
      method,
      details: { date: israelDate(), cancelled_by: byName },
      creditOf: invoice.id,
    });
    return true;
  });
}

export interface CancelDocRow {
  kind: 'invoice' | 'credit';
  status: DocStatus;
  last_error: string | null;
  numbers: string[];
  email_status: 'sent' | 'no_email' | null;
  email_to: string | null;
}

/** The order's Morning documents, oldest first. */
export async function documentRowsOfOrder(orderId: string): Promise<CancelDocRow[]> {
  const r = await query<CancelDocRow>(
    `select kind, status, last_error,
            coalesce((select array_agg(x->>'number') from jsonb_array_elements(morning_docs) x), '{}') as numbers,
            email_status, email_to
       from public.chip_order_documents where order_id = $1 order by created_at`,
    [orderId],
  );
  return r.rows;
}

/** What the "ביטול וזיכוי" confirmation shows (GET /api/chip-orders/[id]/cancel). */
export type ReceptionCancelPreview = ReceptionCancelPreviewView;

export async function getReceptionCancelPreview(orderId: string): Promise<ReceptionCancelPreview | null> {
  const o = await queryOne<{
    id: string; order_number: number; status: ChipOrderStatus; source: string; is_test: boolean; total: number;
    payment_method: string | null; card_status: string | null; card_env: 'sandbox' | 'production' | null; card_last4: string | null;
    card_paid_amount: number | null; email: string | null; invoice_number: string | null;
    cancel_requested_at: string | null; cancel_requested_by_name: string | null; cancel_request_reason: string | null;
    cancel_failed_step: CancelStep | null; cancel_error: string | null;
    refunded_at: string | null; refund_via: string | null; refund_note: string | null; refund_requested_at: string | null;
  }>(
    `select id, order_number, status, source, is_test, total::float8 as total, payment_method, card_status, card_env, card_last4,
            card_paid_amount::float8 as card_paid_amount, email, invoice_number,
            cancel_requested_at, cancel_requested_by_name, cancel_request_reason, cancel_failed_step, cancel_error,
            refunded_at, refund_via, refund_note, refund_requested_at
       from public.chip_orders where id = $1`,
    [orderId],
  );
  if (!o || o.source !== 'reception') return null;
  const chips = (
    await query<{ chip_number: string }>(
      `select c.chip_number
         from public.chips c
         join public.chip_order_items i on i.id = c.order_item_id
        where i.order_id = $1 and c.status = 'active' and c.contact_id is not distinct from i.contact_id
        order by c.chip_number`,
      [orderId],
    )
  ).rows.map((r) => r.chip_number);
  const docs = await documentRowsOfOrder(orderId);
  const cardPaid = o.payment_method === 'card' && o.card_status === 'paid';
  return {
    order_id: o.id,
    order_number: o.order_number,
    status: o.status,
    is_test: o.is_test,
    amount: cardPaid ? o.card_paid_amount ?? o.total : o.total,
    payment_method: o.payment_method,
    card: cardPaid ? { last4: o.card_last4, env: o.card_env } : null,
    email: o.email,
    invoice_number: o.invoice_number,
    has_invoice: docs.some((d) => d.kind === 'invoice'),
    chips,
    requested_at: o.cancel_requested_at,
    requested_by_name: o.cancel_requested_by_name,
    reason: o.cancel_request_reason,
    failed_step: o.cancel_failed_step,
    error: o.cancel_error,
    refunded: o.refunded_at !== null,
    refund_via: o.refund_via,
    refund_note: o.refund_note,
    credit_numbers: docs.filter((d) => d.kind === 'credit' && d.status === 'issued').flatMap((d) => d.numbers),
    refund_unanswered: o.refund_requested_at !== null && o.refunded_at === null,
    cancellable: o.status === 'collected' || (o.status === 'paid' && cardPaid),
  };
}

import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import { deactivateChipInTx } from '@/lib/db/chips';
import { ChipOrderStateError } from '@/lib/db/chipOrders';
import { REFUND_CALL_SECONDS, type RefundTarget } from '@/lib/db/chipOrderRefund';
import { enqueueDocumentInTx, getInvoiceRowOfOrderInTx, type DocStatus } from '@/lib/db/chipOrderDocuments';
import { israelDate } from '@/lib/morning/documents';
import type { ChipOrderStatus } from '@/lib/chipOrders/model';
import type { ReceptionCancelPreviewView, ReceptionCancelStep } from '@/lib/chipOrders/receptionCancelText';

// "ביטול וזיכוי" (27/11/2026) — the state of its steps on the order
// (migrations 20261126220000, 20261126225119). Since 27/11/2026 it is the one
// way back for EVERY order: a reception order (collected, or paid by card
// with its chips never saved) and a web order the card paid (it replaced
// "זיכוי"; "דחה" of such an order runs the same steps). The steps run in
// src/lib/chipOrders/receptionCancel.ts, in this order: the refund in PayPlus
// (a card — src/lib/chipOrders/refund.ts, the one refund of the module), the
// credit document in Morning, the cancellation (the order `rejected`, its
// chips disabled, cancel_completed_at — one transaction). A failed step is
// stored with its words; a retry starts again at the first step that is not
// done — and a refund that went through is never sent again.

export type CancelStep = ReceptionCancelStep;

/** One run at a time per order: the lease beginCancelAndCredit takes —
 *  longer than the slowest run (every PayPlus / Morning call waits up to 20
 *  seconds); a run that crashed holds the order this long at most. */
const RUN_LEASE_SECONDS = 300;
export interface CancelTarget extends RefundTarget {
  status: ChipOrderStatus;
  source: 'web' | 'reception';
  payment_method: string | null;
  card_status: string | null;
  /** This run's lease (its end, as stored): only this run lets it go. */
  lease: string;
}

/** May "ביטול וזיכוי" act on this order now? Null = yes; otherwise the
 *  ChipOrderStateError it is refused with. A reception order: collected, or
 *  paid by card with its chips never saved — and not cancelled. A web order:
 *  paid BY CARD (the processor confirmed a charge), in any status, with no
 *  "ביטול וזיכוי" finished. */
export function cancelRefusal(o: {
  source: string; status: string; payment_method: string | null; card_status: string | null; cancel_completed_at: string | null;
  refund_status: string | null; cancel_requested_at: string | null;
}): 'already_cancelled' | 'not_cancellable' | 'not_card_paid' | null {
  if (o.cancel_completed_at) return 'already_cancelled';
  // A web order refunded in full before 27/11/2026 ("זיכוי" / "דחה" of old):
  // nothing is left to run.
  if (o.source === 'web' && o.refund_status === 'refunded' && !o.cancel_requested_at) return 'already_cancelled';
  if (o.source === 'reception') {
    if (o.status === 'rejected') return 'already_cancelled';
    const paidByCardNoChips = o.status === 'paid' && o.payment_method === 'card' && o.card_status === 'paid';
    return o.status === 'collected' || paidByCardNoChips ? null : 'not_cancellable';
  }
  if (o.status === 'pending_payment') return 'not_cancellable';
  return o.card_status === 'paid' ? null : 'not_card_paid';
}

/**
 * Starts (or resumes) "ביטול וזיכוי": the order locked, checked
 * (cancelRefusal), marked as requested — who, when, why — with its last
 * failure cleared and a lease taken. `reason` is required the first time; a
 * retry keeps the first one. Null = no such order.
 */
export async function beginCancelAndCredit(
  orderId: string,
  reason: string | null,
  by: { id: string; name: string },
): Promise<CancelTarget | null> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<Omit<CancelTarget, 'reason' | 'lease'> & {
        cancel_requested_at: string | null; running: boolean; cancel_request_reason: string | null; cancel_completed_at: string | null;
        refund_status: string | null;
      }>(
        `select id, order_number, status, source, is_test, total::float8 as total, payment_method, card_status, card_env,
                card_transaction_uid, card_page_request_uid, card_paid_amount::float8 as card_paid_amount, refunded_at,
                refunded_amount::float8 as refunded_amount, refund_via, refund_requested_at,
                (refund_requested_at is not null and refund_requested_at > now() - make_interval(secs => $2)) as refund_call_running,
                cancel_requested_at, cancel_request_reason, cancel_completed_at, refund_status,
                (cancel_running_until is not null and cancel_running_until > now()) as running
           from public.chip_orders where id = $1 for update`,
        [orderId, REFUND_CALL_SECONDS],
      )
    ).rows[0];
    if (!o) return null;
    const refused = cancelRefusal(o);
    if (refused) throw new ChipOrderStateError(refused);
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
        action: o.source === 'reception' ? 'reception_cancel_started' : 'cancel_credit_started',
        entityType: 'chip_order',
        entityId: orderId,
        metadata: { order_number: o.order_number, source: o.source, reason: why, amount: o.total, payment_method: o.payment_method },
      });
    }
    return {
      id: o.id, order_number: o.order_number, status: o.status, source: o.source, is_test: o.is_test, total: o.total,
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
export async function failCancelStep(
  orderId: string, step: CancelStep, message: string, by: { id: string; name: string }, lease: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const r = await client.query<{ order_number: number; source: string }>(
      `update public.chip_orders
          set cancel_failed_step = $2, cancel_error = $3,
              cancel_running_until = case when cancel_running_until = $4::timestamptz then null else cancel_running_until end,
              updated_at = now()
        where id = $1 and cancel_completed_at is null and cancel_requested_at is not null
        returning order_number, source`,
      [orderId, step, message.trim().slice(0, 500) || 'השלב נכשל', lease],
    );
    if (r.rows[0]) {
      await writeAuditInTx(client, {
        actorUserId: by.id,
        action: r.rows[0].source === 'reception' ? 'reception_cancel_failed' : 'cancel_credit_failed',
        entityType: 'chip_order',
        entityId: orderId,
        metadata: { order_number: r.rows[0].order_number, step, message: message.slice(0, 500) },
      });
    }
  });
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

/**
 * The last step of "ביטול וזיכוי" of a WEB order (27/11/2026), in one
 * transaction: every active chip issued to it disabled (never deleted; a chip
 * moved to another apartment since is left alone); an order still open
 * (paid / ready) `rejected` with the reason — a COLLECTED one stays collected
 * (it was handed over; its refund and chips say the rest, as "זיכוי" left it),
 * and one rejected before ("דחה") keeps its own reason; the run finished
 * (cancel_completed_at) and the PayPlus warning cleared; audited. Null = no
 * such order. Its refund and its credit document were the steps before (the
 * refund queued that credit).
 */
export async function finishWebCancel(
  orderId: string,
  reason: string,
  by: { id: string; name: string },
  steps: Record<string, unknown>,
): Promise<{ order_number: number; chips_disabled: number } | null> {
  return withTransaction(async (client) => {
    const o = (
      await client.query<{ order_number: number; source: string; status: string; card_status: string | null; cancel_completed_at: string | null }>(
        `select order_number, source, status, card_status, cancel_completed_at from public.chip_orders where id = $1 for update`,
        [orderId],
      )
    ).rows[0];
    if (!o) return null;
    if (o.source !== 'web') throw new ChipOrderStateError('not_web_order');
    if (o.cancel_completed_at) throw new ChipOrderStateError('already_cancelled');
    if (o.card_status !== 'paid') throw new ChipOrderStateError('not_card_paid');
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
    ).rows;
    const chips = active.filter((c) => !c.moved);
    for (const c of chips) {
      await deactivateChipInTx(client, c.id, { reason: 'unknown', note: `ביטול וזיכוי הזמנה ${o.order_number}` }, by);
    }
    const close = o.status === 'paid' || o.status === 'approved' || o.status === 'ready';
    await client.query(
      `update public.chip_orders
          set status = case when $3::boolean then 'rejected' else status end,
              rejected_at = case when $3::boolean then now() else rejected_at end,
              reject_reason = case when $3::boolean then $2 else reject_reason end,
              cancel_failed_step = null, cancel_error = null, cancel_running_until = null,
              cancel_completed_at = now(), payplus_reversal_at = null, payplus_reversal_kind = null,
              updated_at = now()
        where id = $1`,
      [orderId, reason, close],
    );
    await writeAuditInTx(client, {
      actorUserId: by.id,
      action: 'cancel_credit_done',
      entityType: 'chip_order',
      entityId: orderId,
      metadata: {
        source: 'web', order_number: o.order_number, reason, status_before: o.status, closed: close,
        chips_disabled: chips.length, chips_left_moved: active.length - chips.length, steps,
      },
    });
    return { order_number: o.order_number, chips_disabled: chips.length };
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
    id: string; order_number: number; status: ChipOrderStatus; source: 'web' | 'reception'; is_test: boolean; total: number;
    payment_method: string | null; card_status: string | null; card_env: 'sandbox' | 'production' | null; card_last4: string | null;
    card_paid_amount: number | null; email: string | null; invoice_number: string | null;
    cancel_requested_at: string | null; cancel_requested_by_name: string | null; cancel_request_reason: string | null;
    cancel_failed_step: CancelStep | null; cancel_error: string | null; cancel_completed_at: string | null;
    refunded_at: string | null; refund_via: string | null; refund_note: string | null; refund_requested_at: string | null;
    refund_status: string | null; payplus_reversal_kind: 'cancelled' | 'refunded' | 'partial' | null;
  }>(
    `select id, order_number, status, source, is_test, total::float8 as total, payment_method, card_status, card_env, card_last4,
            card_paid_amount::float8 as card_paid_amount, email, invoice_number,
            cancel_requested_at, cancel_requested_by_name, cancel_request_reason, cancel_failed_step, cancel_error, cancel_completed_at,
            refunded_at, refund_via, refund_note, refund_requested_at, refund_status, payplus_reversal_kind
       from public.chip_orders where id = $1`,
    [orderId],
  );
  if (!o || o.status === 'pending_payment') return null;
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
  const cardPaid = o.card_status === 'paid' && (o.source === 'web' || o.payment_method === 'card');
  return {
    order_id: o.id,
    order_number: o.order_number,
    source: o.source,
    status: o.status,
    is_test: o.is_test,
    amount: cardPaid ? o.card_paid_amount ?? o.total : o.total,
    payment_method: o.source === 'web' ? 'card' : o.payment_method,
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
    refunded: o.refunded_at !== null && o.refund_status === 'refunded',
    refund_via: o.refund_via,
    refund_note: o.refund_note,
    credit_numbers: docs.filter((d) => d.kind === 'credit' && d.status === 'issued').flatMap((d) => d.numbers),
    refund_unanswered: o.refund_requested_at !== null && o.refunded_at === null,
    payplus_reversal: o.payplus_reversal_kind,
    cancellable: cancelRefusal(o) === null,
  };
}

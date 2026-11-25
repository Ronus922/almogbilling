import 'server-only';
import { logger } from '@/lib/logger';
import { queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { listRecentCardSessions, recordCardFailure, recordCardPayment, type CardOrder } from '@/lib/db/chipOrderCard';
import {
  isApprovedCharge, lookupPaymentRequest, payplusConfig, type PayPlusConfig, type PayPlusTransaction,
} from '@/lib/payplus/client';

// Chip orders — card payment through PayPlus: the rules both server paths
// share (the callback and the lookup).
//
// WHO MAY PAY BY CARD, IN THIS BUILD
//   PAYPLUS_MODE=sandbox  → a TEST order only (the test link of /settings).
//                           A real order never reaches the payment step, and a
//                           sandbox charge can never mark one paid: the route,
//                           the UPDATE and a CHECK of the table each refuse it.
//   PAYPLUS_MODE=production → nobody yet. Opening card payment to real orders
//                           is a separate step (docs/chip-orders.md, "מה נדרש
//                           כדי לעלות לאוויר") — until it is done this returns
//                           null and the page behaves as it did before.

/** The PayPlus configuration under which a TEST order pays by (sandbox) card,
 *  or null — then the test order ends with "סיים הזמנת בדיקה" as before. */
export function cardStepConfig(): PayPlusConfig | null {
  const cfg = payplusConfig();
  return cfg && cfg.mode === 'sandbox' ? cfg : null;
}

/** May THIS order open a card payment session now? */
export function orderMayPayByCard(cfg: PayPlusConfig, order: Pick<CardOrder, 'is_test' | 'source' | 'status'>): boolean {
  return cfg.mode === 'sandbox' && order.is_test && order.source === 'web' && order.status === 'pending_payment';
}

export type CardSource = 'payplus_callback' | 'payplus_lookup';

export type AppliedTransaction =
  /** The order is paid; `transitioned` only for the call that made it so. */
  | { kind: 'paid'; orderId: string; transitioned: boolean }
  /** A refused attempt — kept on the order when it still waits. */
  | { kind: 'failed' }
  /** Nothing of ours, or something that must not change an order. */
  | { kind: 'ignored'; why: string };

/** What an admin reads as the reason of a refused attempt: the processor's own
 *  status code and text (never card data — none is read from the payload). */
function failureReason(tx: PayPlusTransaction): string {
  const said = tx.statusDescription && tx.statusDescription !== tx.statusCode ? ` — ${tx.statusDescription}` : '';
  return `העסקה נדחתה (קוד ${tx.statusCode}${said})`;
}

/** One audit row per anomaly per transaction, however often it is reported. */
async function auditAnomalyOnce(orderId: string, kind: string, tx: PayPlusTransaction, cfg: PayPlusConfig, source: CardSource): Promise<void> {
  const seen = await queryOne<{ ok: number }>(
    `select 1 as ok from public.audit_log
      where entity_type = 'chip_order' and entity_id = $1 and action = 'card_payment_anomaly'
        and metadata->>'transaction_uid' = $2 and metadata->>'kind' = $3 limit 1`,
    [orderId, tx.uid, kind],
  ).catch(() => null);
  if (seen) return;
  await writeAudit({
    actorUserId: null,
    action: 'card_payment_anomaly',
    entityType: 'chip_order',
    entityId: orderId,
    metadata: { kind, source, provider: 'payplus', env: cfg.mode, transaction_uid: tx.uid, amount: tx.amount, approval_number: tx.approvalNumber },
  });
}

/**
 * Applies ONE transaction the processor reported to the order it names. The
 * caller has already established that `tx` really comes from PayPlus (a
 * callback whose signature was checked, or the reply of our own lookup).
 * Idempotent: the same transaction again changes nothing and reports
 * `transitioned: false`, so nothing is announced twice.
 *
 * An order is touched only when the transaction carries BOTH the order's
 * number (the more_info we sent) and a payment session this server opened for
 * that order — and it becomes paid only for an approved "Charge" of exactly
 * its total, in ILS.
 */
export async function applyPayPlusTransaction(cfg: PayPlusConfig, tx: PayPlusTransaction, source: CardSource): Promise<AppliedTransaction> {
  if (!tx.moreInfo || !/^\d{1,9}$/.test(tx.moreInfo)) return { kind: 'ignored', why: 'no_order_number' };
  const orderNumber = Number(tx.moreInfo);
  // A refund, a card check, a recurring charge… — not something this flow acts on.
  if (tx.type !== null && tx.type !== 'charge') return { kind: 'ignored', why: `type_${tx.type}` };

  if (tx.statusCode !== '000') {
    await recordCardFailure({ env: cfg.mode, orderNumber, pageRequestUid: tx.pageRequestUid, reason: failureReason(tx) });
    return { kind: 'failed' };
  }
  if (!isApprovedCharge(tx)) {
    // Status 000 on a payload that does not say what kind of transaction it
    // is: neither paid nor "refused" — reported, and left for a person.
    logger.error('[chip-order] payplus transaction approved (000) but its kind is not stated — not applied', { orderNumber, source });
    return { kind: 'ignored', why: 'kind_not_stated' };
  }
  if (tx.currency && tx.currency !== 'ILS') {
    logger.error('[chip-order] payplus charge in a foreign currency — ignored', { orderNumber, source, currency: tx.currency });
    return { kind: 'ignored', why: 'currency' };
  }

  const outcome = await recordCardPayment({
    env: cfg.mode, orderNumber, transactionUid: tx.uid, pageRequestUid: tx.pageRequestUid,
    amount: tx.amount, approvalNumber: tx.approvalNumber, last4: tx.last4,
  }, source);
  switch (outcome.kind) {
    case 'paid':
      if (tx.payments !== null && tx.payments > 1) {
        logger.error('[chip-order] payplus charge in more than one payment', { orderNumber, payments: tx.payments });
      }
      return { kind: 'paid', orderId: outcome.orderId, transitioned: true };
    case 'already_paid':
      return { kind: 'paid', orderId: outcome.orderId, transitioned: false };
    case 'unknown_order':
      // Money may have been taken for an order number that does not exist here.
      logger.error('[chip-order] approved payplus charge for an unknown order number', { orderNumber, source, env: cfg.mode });
      return { kind: 'ignored', why: 'unknown_order' };
    case 'duplicate_charge':
      // Money was taken twice (or on a closed order): the refund is done by a
      // person, in PayPlus. Loud in the log, once in the audit trail.
      logger.error('[chip-order] SECOND approved card charge on an order that is already paid or closed — refund it in PayPlus', { orderNumber, source, env: cfg.mode });
      await auditAnomalyOnce(outcome.orderId, 'duplicate_charge', tx, cfg, source);
      return { kind: 'ignored', why: 'duplicate_charge' };
    case 'amount_mismatch':
      logger.error('[chip-order] approved card charge whose amount is not the order total — the order stays unpaid', { orderNumber, source, expected: outcome.expected, charged: tx.amount });
      await auditAnomalyOnce(outcome.orderId, 'amount_mismatch', tx, cfg, source);
      return { kind: 'ignored', why: 'amount_mismatch' };
    case 'wrong_environment':
      logger.error('[chip-order] card charge of one environment for an order of the other — refused', { orderNumber, source, env: cfg.mode });
      await auditAnomalyOnce(outcome.orderId, 'wrong_environment', tx, cfg, source);
      return { kind: 'ignored', why: 'wrong_environment' };
    case 'no_session':
      logger.error('[chip-order] card charge that names no payment session of the order — refused', { orderNumber, source });
      await auditAnomalyOnce(outcome.orderId, 'no_session', tx, cfg, source);
      return { kind: 'ignored', why: 'no_session' };
  }
}

export type CardLookup =
  /** PayPlus reports an approved charge of the order — it is paid now. */
  | { kind: 'paid'; orderId: string; transitioned: boolean }
  /** PayPlus answered for every recent session of the order: nothing approved.
   *  `refused` — at least one refused attempt was among the answers. */
  | { kind: 'not_charged'; refused: boolean }
  /** At least one session could not be asked about (PayPlus refused, did not
   *  answer, or answered something unreadable): a charge is NOT ruled out. */
  | { kind: 'unknown' };

/**
 * The server-side lookup: asks PayPlus what happened on the order's recent
 * payment sessions — every one of them, not only the last, so a charge that
 * was approved on an earlier session is found too — and applies what it
 * reports. Used when the callback is late: the browser's "the payment went
 * through" only makes the SERVER ask; the answer comes from PayPlus.
 */
export async function lookupCardPayment(
  cfg: PayPlusConfig,
  order: Pick<CardOrder, 'id' | 'order_number'>,
  maxSessions = 4,
): Promise<CardLookup> {
  const sessions = await listRecentCardSessions(order.id, cfg.mode, maxSessions);
  let unknown = false;
  let refused = false;
  for (const pageRequestUid of sessions) {
    const found = await lookupPaymentRequest(cfg, pageRequestUid);
    if (found.kind === 'unknown') {
      // Not at error level: this repeats on every poll while PayPlus refuses us.
      logger.warn('[chip-order] payplus lookup gave no answer', { orderId: order.id, status: found.status, message: found.message });
      unknown = true;
      continue;
    }
    for (const reported of found.transactions) {
      // We asked about OUR session of THIS order: the transaction is the
      // order's. A transaction that names another order is a processor fault.
      if (reported.moreInfo !== null && reported.moreInfo !== String(order.order_number)) {
        logger.error('[chip-order] payplus lookup returned a transaction of another order — ignored', { orderId: order.id });
        unknown = true;
        continue;
      }
      const tx: PayPlusTransaction = { ...reported, moreInfo: String(order.order_number), pageRequestUid };
      const applied = await applyPayPlusTransaction(cfg, tx, 'payplus_lookup');
      if (applied.kind === 'paid') return { kind: 'paid', orderId: applied.orderId, transitioned: applied.transitioned };
      if (applied.kind === 'failed') refused = true;
      else unknown = true; // approved-looking but not applied: a person must look
    }
  }
  return unknown ? { kind: 'unknown' } : { kind: 'not_charged', refused };
}

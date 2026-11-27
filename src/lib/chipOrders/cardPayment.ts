import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { queryOne } from '@/lib/db';
import { writeAudit } from '@/lib/db/audit';
import { alertChipOrderAdmins } from './alerts';
import { getCardOrderByNumber, listRecentCardSessions, recordCardFailure, recordCardPayment, type CardOrder } from '@/lib/db/chipOrderCard';
import {
  isApprovedCharge, lookupPaymentRequest, payplusConfigFor, type PayPlusConfig, type PayPlusMode, type PayPlusTransaction,
} from '@/lib/payplus/client';

// Chip orders — card payment through PayPlus: the rules both server paths
// share (the callback and the lookup).
//
// WHO MAY PAY BY CARD (26/11/2026)
//   A TEST order (the test link of /settings) → ALWAYS the sandbox, with the
//       DEV values — whatever PAYPLUS_MODE says. No DEV values = no card step
//       for test orders ("סיים הזמנת בדיקה" as before; CI runs that way).
//   A REAL order → production, and only while real charging is ARMED:
//       PAYPLUS_MODE=production + the three PROD values + PAYPLUS_LIVE_CHARGING=on.
//       Anything less = no real charge anywhere (the public page stays closed,
//       the reception has no card).
// A sandbox charge can never mark a real order paid, nor a production charge a
// test order: the routes, the UPDATE and a CHECK of the table each refuse it.

/** The sandbox configuration — the test link always pays here. */
export function testCardConfig(): PayPlusConfig | null {
  return payplusConfigFor('sandbox');
}

/** Real charging is ARMED: production mode, its three values, and the explicit
 *  live-charging switch. Null = no real charge anywhere. */
export function liveCardConfig(): PayPlusConfig | null {
  if (env.PAYPLUS_MODE !== 'production' || env.PAYPLUS_LIVE_CHARGING !== 'on') return null;
  return payplusConfigFor('production');
}

/** The configuration an order of this kind pays with now, or null. */
export function cardConfigFor(isTest: boolean): PayPlusConfig | null {
  return isTest ? testCardConfig() : liveCardConfig();
}

/** The configuration to ASK PayPlus about a session that was opened in `mode`
 *  — the environment's own values, whether or not new charges are armed
 *  (a charge that was made before the switch went off must still be found). */
export function lookupConfigFor(mode: PayPlusMode): PayPlusConfig | null {
  return payplusConfigFor(mode);
}

/** What /settings shows about card payment (never a secret). */
export interface CardChargingState {
  /** PAYPLUS_MODE as set ('sandbox' | 'production'), or null. */
  mode: PayPlusMode | null;
  sandboxConfigured: boolean;
  productionConfigured: boolean;
  /** PAYPLUS_LIVE_CHARGING=on */
  switchOn: boolean;
  /** Real charges are armed (all three conditions). */
  live: boolean;
}
export function cardChargingState(): CardChargingState {
  return {
    mode: env.PAYPLUS_MODE ?? null,
    sandboxConfigured: payplusConfigFor('sandbox') !== null,
    productionConfigured: payplusConfigFor('production') !== null,
    switchOn: env.PAYPLUS_LIVE_CHARGING === 'on',
    live: liveCardConfig() !== null,
  };
}

/** May THIS order open a card payment session now, under `cfg`? The session's
 *  environment must be the order's kind: the sandbox for a test order,
 *  production for a real one. */
export function orderMayPayByCard(cfg: PayPlusConfig, order: Pick<CardOrder, 'is_test' | 'source' | 'status'>): boolean {
  return (cfg.mode === 'sandbox') === order.is_test && order.source === 'web' && order.status === 'pending_payment';
}

/** The same rule for a reception order waiting for its card payment (26/11/2026). */
export function receptionOrderMayPayByCard(cfg: PayPlusConfig, order: Pick<CardOrder, 'is_test' | 'source' | 'status'>): boolean {
  return (cfg.mode === 'sandbox') === order.is_test && order.source === 'reception' && order.status === 'pending_payment';
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
  // Money may have been taken that no order holds: a person must look (and
  // refund it in PayPlus when it is a second charge). The sandbox is a test.
  if (cfg.mode === 'production') {
    await alertChipOrderAdmins({
      orderId,
      title: 'חיוב בכרטיס שאינו תואם להזמנה',
      message: ANOMALY_TEXT[kind] ?? `חיוב של ${tx.amount}₪ (אישור ${tx.approvalNumber ?? '—'}) לא הוחל על ההזמנה (${kind}). יש לבדוק ב-PayPlus.`,
      dedupeKey: `chip_card_anomaly:${tx.uid}:${kind}`,
    });
  }
}

/** An APPROVED charge for an order number this database does not hold — an
 *  unpaid order the purge already deleted, or nothing of ours: money may have
 *  been taken that no order holds, and no row is left to show it. Every admin
 *  is told (production only — the sandbox is a test). */
async function alertUnknownOrder(cfg: PayPlusConfig, tx: PayPlusTransaction, orderNumber: number): Promise<void> {
  if (cfg.mode !== 'production') return;
  await alertChipOrderAdmins({
    orderId: null,
    title: `חיוב בכרטיס להזמנה שאינה קיימת — ${orderNumber}`,
    message: `PayPlus דיווח על חיוב מאושר של ${tx.amount}₪ (אישור ${tx.approvalNumber ?? '—'}, מזהה ${tx.uid}) להזמנה ${orderNumber}, שאינה קיימת במערכת (ייתכן שנמחקה כהזמנה שלא שולמה). יש לבדוק ב-PayPlus ולזכות את הלקוח אם צריך.`,
    dedupeKey: `chip_card_unknown_order:${tx.uid}`,
  });
}

const ANOMALY_TEXT: Record<string, string> = {
  duplicate_charge: 'התקבל חיוב שני על הזמנה שכבר שולמה — יש לזכות אותו ב-PayPlus.',
  amount_mismatch: 'התקבל חיוב בסכום שאינו סכום ההזמנה — ההזמנה לא סומנה „שולם”. יש לבדוק ב-PayPlus ולזכות.',
  wrong_environment: 'התקבל חיוב מסביבה שאינה של ההזמנה — לא הוחל.',
  no_session: 'התקבל חיוב שאינו שייך לאף חלון תשלום של ההזמנה — לא הוחל. יש לבדוק ב-PayPlus.',
};

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
      await alertUnknownOrder(cfg, tx, orderNumber);
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
   *  `refused` — at least one refused attempt was among the answers;
   *  `checked` — how many sessions were asked about (the purge compares it
   *  with every session the order ever had). */
  | { kind: 'not_charged'; refused: boolean; checked: number }
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
  /** How far back sessions are asked about (default: the recent ones a charge
   *  may still arrive on). The purge asks about every session the order had. */
  withinMinutes?: number,
): Promise<CardLookup> {
  const sessions = await listRecentCardSessions(order.id, cfg.mode, maxSessions, withinMinutes);
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
  return unknown ? { kind: 'unknown' } : { kind: 'not_charged', refused, checked: sessions.length };
}

/** What a validated callback led to. `unconfirmed` — PayPlus could not be
 *  asked just now: the caller answers with an error so the notice is sent again. */
export type AppliedCallback = AppliedTransaction | { kind: 'unconfirmed' };

/**
 * A callback whose signature was checked.
 *
 * When it names the payment session it went through, it is applied as it is
 * (applyPayPlusTransaction). PayPlus's hosted-fields notice does NOT name one
 * (seen on the sandbox, 25/11/2026) — and the order number alone pays nothing.
 * So such a notice is only a signal: the server asks PayPlus itself about the
 * payment sessions it opened for that order, and applies what PayPlus answers
 * there — the same lookup the order page triggers. The charge is then bound
 * to one of the order's own sessions by the question that was asked, not by
 * anything the notice says.
 */
export async function applyPayPlusCallback(cfg: PayPlusConfig, tx: PayPlusTransaction): Promise<AppliedCallback> {
  if (tx.pageRequestUid !== null) return applyPayPlusTransaction(cfg, tx, 'payplus_callback');
  if (!tx.moreInfo || !/^\d{1,9}$/.test(tx.moreInfo)) return { kind: 'ignored', why: 'no_order_number' };
  if (tx.type !== null && tx.type !== 'charge') return { kind: 'ignored', why: `type_${tx.type}` };
  const orderNumber = Number(tx.moreInfo);
  const order = await getCardOrderByNumber(orderNumber);
  if (!order) {
    if (tx.statusCode === '000') {
      logger.error('[chip-order] approved payplus charge for an unknown order number', { orderNumber, source: 'payplus_callback', env: cfg.mode });
      await alertUnknownOrder(cfg, tx, orderNumber);
    }
    return { kind: 'ignored', why: 'unknown_order' };
  }
  let found: CardLookup;
  try {
    found = await lookupCardPayment(cfg, order);
  } catch (e) {
    logger.warn('[chip-order] payplus lookup failed after a callback', { orderId: order.id, message: (e as Error).name });
    found = { kind: 'unknown' };
  }
  if (found.kind === 'paid') return { kind: 'paid', orderId: found.orderId, transitioned: found.transitioned };
  if (found.kind === 'unknown') return { kind: 'unconfirmed' };
  if (found.refused) return { kind: 'failed' };
  if (tx.statusCode === '000') {
    // An approved charge, yet nothing on the order's RECENT sessions. A late or
    // resent notice can come after those 45 minutes: every session of the
    // reconcile window (48 hours) is asked about before this is an anomaly.
    let wide: CardLookup;
    try {
      wide = await lookupCardPayment(cfg, order, 25, 48 * 60);
    } catch (e) {
      logger.warn('[chip-order] payplus lookup failed after a callback', { orderId: order.id, message: (e as Error).name });
      wide = { kind: 'unknown' };
    }
    if (wide.kind === 'paid') return { kind: 'paid', orderId: wide.orderId, transitioned: wide.transitioned };
    if (wide.kind === 'unknown') return { kind: 'unconfirmed' };
    // PayPlus signed an approved charge that carries this order's number, yet
    // reports nothing on any session this server opened for the order.
    logger.error('[chip-order] card charge that names no payment session of the order — refused', { orderNumber, source: 'payplus_callback' });
    await auditAnomalyOnce(order.id, 'no_session', tx, cfg, 'payplus_callback');
  }
  return { kind: 'ignored', why: 'no_session' };
}

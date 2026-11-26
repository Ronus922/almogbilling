import 'server-only';
import { logger } from '@/lib/logger';
import { queryOne } from '@/lib/db';
import { refundByTransactionUid, type PayPlusConfig, type PayPlusTransaction } from '@/lib/payplus/client';
import { beginRefund, recordRefund, recordRefundFailure, type RefundVia } from '@/lib/db/chipOrderRefund';
import { agorot } from '@/lib/db/chipOrderCard';
import type { ChipOrderStatus } from './model';
import { lookupCardPayment, lookupConfigFor } from './cardPayment';
import { alertChipOrderAdmins } from './alerts';

// Chip orders — refunds of card payments through PayPlus (26/11/2026).
//
// refundCardOrder: "זיכוי" (admin), "דחה" of a card-paid order, and "בטל
// הזמנת קבלה" of a reception card order all go through here. A FULL refund of
// what was charged, through Transactions/RefundByTransactionUID, in the
// environment the order was charged in (a test order → the sandbox; it never
// gets a Morning document). The order is marked in flight BEFORE the call
// (beginRefund); PayPlus's answer is recorded with the order, its chips, the
// credit document and the audit row in one transaction (recordRefund).
//   - refused by PayPlus → refund_status manual_required with PayPlus's words;
//     the money is returned by hand in the PayPlus dashboard (and, when the
//     terminal's callback points here, that refund is then recorded below).
//   - no answer → the outcome is UNKNOWN: the order stays "in flight" for ten
//     minutes, says "check PayPlus", every admin is alerted — never retried
//     blindly (a second refund call could refund twice). PayPlus's own signed
//     notice of that refund, arriving after the call, records it.
//   - PayPlus refunded but recording it failed → the order says so, stays in
//     flight, and (production) every admin is alerted to record it by hand.
//
// applyPayPlusRefundNotice: a refund PayPlus REPORTED (a validated callback
// with transaction_type Refund) — made in the dashboard, or ours echoed back.
// Idempotent per refund id; the order is found by the order number it carries
// (PayPlus documents no field naming the refunded charge — every such refund
// of a production order is put in front of a person).

/** The refund call's own lifetime: PayPlus's 20-second timeout
 *  (src/lib/payplus/client.ts) with a margin. A refund notice of an order whose
 *  refund was asked for less than this ago waits for that call's own answer. */
const REFUND_CALL_SECONDS = 30;

export type RefundResult =
  | { kind: 'refunded'; full: boolean; closed: boolean; chipsDisabled: number }
  | { kind: 'manual_required'; note: string }
  | { kind: 'unknown'; note: string };

export async function refundCardOrder(
  orderId: string,
  opts: {
    via: Exclude<RefundVia, 'payplus'>;
    reason: string;
    by: { id: string; name: string };
    /** The statuses this action may refund in. */
    statuses: readonly ChipOrderStatus[];
    /** The order sources this action may refund ('web' unless said). */
    sources?: readonly string[];
    closeOpen: boolean;
    disableChips: boolean;
  },
): Promise<RefundResult | null> {
  const o = await beginRefund(orderId, opts.statuses, opts.sources ?? ['web']);
  if (!o) return null;
  const cfg = lookupConfigFor(o.card_env ?? (o.is_test ? 'sandbox' : 'production'));
  if (!cfg) {
    const note = 'PayPlus אינו מוגדר בשרת לסביבה של ההזמנה — יש לזכות ידנית בממשק PayPlus';
    await recordRefundFailure(orderId, note, false);
    return { kind: 'manual_required', note };
  }
  let res;
  try {
    res = await refundByTransactionUid(cfg, { transactionUid: o.card_transaction_uid, amount: o.card_paid_amount, moreInfo: `refund:${o.order_number}` });
  } catch (e) {
    res = { kind: 'unknown' as const, status: 0, message: (e as Error).name };
  }
  if (res.kind === 'refunded') {
    let rec: Awaited<ReturnType<typeof recordRefund>>;
    try {
      rec = await recordRefund(orderId, {
        refundUid: res.refundUid, amount: o.card_paid_amount, via: opts.via, by: opts.by, reason: opts.reason,
        closeOpen: opts.closeOpen, disableChips: opts.disableChips,
      });
    } catch (e) {
      // PayPlus REFUNDED, and recording it failed (a database error): the money
      // is back with the customer while nothing on the order says so. The
      // in-flight mark stays, the order says it, and a person records it — the
      // refund must never be sent a second time.
      logger.error('[chip-orders] refund confirmed by PayPlus but recording it failed', { orderId, refundUid: res.refundUid, err: (e as Error).name });
      const note = `PayPlus אישר זיכוי (${res.refundUid}) אך רישומו בהזמנה נכשל — אין לזכות שוב; יש לרשום את הזיכוי ידנית`;
      await recordRefundFailure(orderId, note, true).catch(() => undefined);
      if (cfg.mode === 'production') {
        await alertChipOrderAdmins({
          orderId,
          title: `זיכוי שבוצע ולא נרשם — הזמנה ${o.order_number}`,
          message: `PayPlus אישר זיכוי של ${res.amount}₪ (מזהה הזיכוי ${res.refundUid}) להזמנה ${o.order_number}, אבל רישומו בהזמנה נכשל. אין לזכות שוב — יש לרשום את הזיכוי ידנית.`,
          dedupeKey: `chip_refund_unrecorded:${res.refundUid}`,
        });
      }
      return { kind: 'manual_required', note };
    }
    if (rec.kind === 'recorded') return { kind: 'refunded', full: rec.full, closed: rec.closed, chipsDisabled: rec.chipsDisabled };
    if (rec.kind === 'already') return { kind: 'refunded', full: true, closed: false, chipsDisabled: 0 };
    // PayPlus refunded, but the order would not take it (cannot happen for a
    // full refund of its own charge) — loud, and left for a person.
    logger.error('[chip-orders] refund confirmed by PayPlus but not recorded', { orderId, why: rec.why });
    await alertChipOrderAdmins({
      orderId,
      title: `זיכוי שבוצע ולא נרשם — הזמנה ${o.order_number}`,
      message: `PayPlus אישר זיכוי (${res.refundUid}) אבל ההזמנה לא עודכנה (${rec.why}). יש לבדוק.`,
      dedupeKey: `chip_refund_unrecorded:${res.refundUid}`,
    });
    return { kind: 'manual_required', note: 'הזיכוי בוצע ב-PayPlus אך לא נרשם בהזמנה — נדרשת בדיקה' };
  }
  if (res.kind === 'refused') {
    const note = `PayPlus סירב לזיכוי: ${res.message}${res.statusCode ? ` (קוד ${res.statusCode})` : ''}`;
    await recordRefundFailure(orderId, note, false);
    return { kind: 'manual_required', note };
  }
  const note = 'לא התקבלה תשובה מ-PayPlus על הזיכוי — יש לבדוק בממשק PayPlus אם הזיכוי בוצע לפני ניסיון נוסף';
  await recordRefundFailure(orderId, note, true);
  await alertChipOrderAdmins({
    orderId,
    title: `זיכוי בלי תשובה — הזמנה ${o.order_number}`,
    message: `נשלחה בקשת זיכוי ל-PayPlus ולא התקבלה תשובה (${res.message}). יש לבדוק בממשק PayPlus אם הזיכוי בוצע.`,
    dedupeKey: `chip_refund_unknown:${orderId}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  return { kind: 'unknown', note };
}

export type RefundNoticeOutcome =
  | { kind: 'recorded'; orderId: string; full: boolean }
  | { kind: 'already' }
  /** Not applied now (our own refund call may still be waiting for its answer,
   *  a notice that does not fit the in-flight refund, or the charge is not
   *  recorded yet and PayPlus could not be asked) — answer 503 so PayPlus
   *  sends it again. */
  | { kind: 'later' }
  | { kind: 'ignored'; why: string };

/** A refund PayPlus reported (transaction_type Refund, signature checked). */
export async function applyPayPlusRefundNotice(cfg: PayPlusConfig, tx: PayPlusTransaction): Promise<RefundNoticeOutcome> {
  if (tx.statusCode !== '000') return { kind: 'ignored', why: 'refund_not_approved' };
  // Ours, already recorded (the refund API answered first)?
  const known = await queryOne<{ id: string }>(`select id from public.chip_orders where refund_transaction_uid = $1`, [tx.uid]);
  if (known) return { kind: 'already' };
  const m = tx.moreInfo ? /^(?:refund:)?(\d{1,9})$/.exec(tx.moreInfo) : null;
  if (!m) {
    if (cfg.mode === 'production') {
      await alertChipOrderAdmins({
        orderId: null,
        title: 'זיכוי ב-PayPlus שלא שויך להזמנה',
        message: `PayPlus דיווח על זיכוי של ${Math.abs(tx.amount)}₪ (מזהה ${tx.uid}) בלי מספר הזמנה. אם הוא שייך להזמנת צ׳יפים — יש לסמן אותה ידנית.`,
        dedupeKey: `chip_refund_unmatched:${tx.uid}`,
      });
    }
    return { kind: 'ignored', why: 'no_order_number' };
  }
  const order = await queryOne<{
    id: string; order_number: number; is_test: boolean; card_env: string | null; card_status: string | null; status: string;
    card_paid_amount: number | null; refunded_amount: number | null; card_transaction_uid: string | null; card_approval_number: string | null;
    in_flight: boolean; call_running: boolean;
  }>(
    `select id, order_number, is_test, card_env, card_status, status,
            card_paid_amount::float8 as card_paid_amount, refunded_amount::float8 as refunded_amount,
            card_transaction_uid, card_approval_number,
            (refund_requested_at is not null and refund_requested_at > now() - interval '10 minutes') as in_flight,
            (refund_requested_at is not null and refund_requested_at > now() - make_interval(secs => $2)) as call_running
       from public.chip_orders where order_number = $1`,
    [Number(m[1]), REFUND_CALL_SECONDS],
  );
  if (!order) return { kind: 'ignored', why: 'unknown_order' };
  if ((order.card_env ?? (order.is_test ? 'sandbox' : 'production')) !== cfg.mode || order.is_test !== (cfg.mode === 'sandbox')) {
    return { kind: 'ignored', why: 'wrong_environment' };
  }
  // A refund may be reported as a negative amount (the docs do not say):
  // what went back is its absolute value.
  const amount = Math.abs(tx.amount);
  if (order.in_flight) {
    // Our own "זיכוי" is in flight. While its call may still be waiting for
    // PayPlus, that call's answer records the refund (with its chips and its
    // reason): the notice waits (503 — PayPlus sends it again). Once the call
    // is over with NO answer (the outcome unknown), a signed notice of a refund
    // of this order that fits what is left of the charge IS that outcome: it
    // is recorded now, not refused for the rest of the ten minutes.
    const left = (order.card_paid_amount ?? 0) - (order.refunded_amount ?? 0);
    const fits = order.card_status === 'paid' && amount > 0 && agorot(amount) <= agorot(left);
    if (order.call_running || !fits) return { kind: 'later' };
  }
  if (order.card_status !== 'paid') {
    // The charge's own notice may not have been applied yet (out of order):
    // ask PayPlus about the order's sessions first.
    const found = await lookupCardPayment(cfg, order, 25, 7 * 24 * 60).catch(() => ({ kind: 'unknown' as const }));
    if (found.kind !== 'paid') return found.kind === 'unknown' ? { kind: 'later' } : { kind: 'ignored', why: 'order_not_paid' };
  }
  const rec = await recordRefund(order.id, {
    refundUid: tx.uid, amount, via: 'payplus', by: null, reason: null, closeOpen: true, disableChips: false,
  });
  if (rec.kind === 'already') return { kind: 'already' };
  if (rec.kind === 'refused') {
    await alertChipOrderAdmins({
      orderId: order.id,
      title: `זיכוי ב-PayPlus שלא נרשם — הזמנה ${order.order_number}`,
      message: `PayPlus דיווח על זיכוי של ${amount}₪ שלא תואם להזמנה (${rec.why}). יש לבדוק.`,
      dedupeKey: `chip_refund_mismatch:${tx.uid}`,
    });
    return { kind: 'ignored', why: rec.why };
  }
  if (cfg.mode === 'production') {
    // PayPlus documents NO field of the refund notice that names the charge it
    // refunds (research 25/11/2026): the notice is bound to the order by its
    // order number alone. A refund of another charge with the same number (a
    // second charge of the order) would be recorded here as this order's — so
    // a person confirms it in PayPlus.
    await alertChipOrderAdmins({
      orderId: order.id,
      title: `זיכוי מ-PayPlus נקלט — הזמנה ${order.order_number}`,
      message: `${rec.full ? 'זיכוי מלא' : 'זיכוי חלקי'} של ${amount}₪ (מזהה ${tx.uid}) נרשם בהזמנה לפי מספר ההזמנה בלבד — PayPlus לא מציין לאיזה חיוב שייך הזיכוי. יש לוודא בממשק PayPlus שזה זיכוי של חיוב ההזמנה (אישור ${order.card_approval_number ?? '—'}, מזהה ${order.card_transaction_uid ?? '—'}) ולא של חיוב אחר (למשל חיוב כפול). הצ׳יפים לא הושבתו אוטומטית.`,
      dedupeKey: `chip_refund_payplus:${tx.uid}`,
    });
  }
  return { kind: 'recorded', orderId: order.id, full: rec.full };
}

import 'server-only';
import { logger } from '@/lib/logger';
import { lookupPaymentRequest, refundByTransactionUid, viewTransactions, type PayPlusConfig } from '@/lib/payplus/client';
import { queryOne } from '@/lib/db';
import { recordRefund, recordRefundFailure } from '@/lib/db/chipOrderRefund';
import { cancelReceptionOrder } from '@/lib/db/chipOrders';
import { releaseDocumentsOfOrder } from '@/lib/db/chipOrderDocuments';
import {
  beginReceptionCancel, documentRowsOfOrder, failReceptionCancel, markReceptionRefundRequested, queueReceptionCancelCredit,
  type CancelStep, type CancelTarget,
} from '@/lib/db/chipReceptionCancel';
import { agorot } from '@/lib/db/chipOrderCard';
import { lookupConfigFor } from './cardPayment';
import { alertChipOrderAdmins } from './alerts';
import { processDueDocuments } from './documents';
import { formatIls } from './model';

// "ביטול וזיכוי" of a reception order (27/11/2026 — what the first real ₪1
// charge of 26/11/2026 exposed: there was no way to undo a paid reception
// order from where it is shown, and a refund made in the PayPlus dashboard left
// the order "paid" with no credit document). Admin and super admin only (the
// route). The steps, IN THIS ORDER — each one only after the one before it:
//
//   1. THE REFUND (a card): PayPlus is asked FIRST whether the charge is still
//      there (Transactions/View, read only). Cancelled (voided the same day)
//      or refunded in PayPlus directly → no refund is sent; the refund is
//      recorded as made "בממשק PayPlus", with a note on the order. Otherwise
//      one full refund (Transactions/RefundByTransactionUID). A refund whose
//      answer never came is NEVER sent again: the retry only asks PayPlus.
//      Cash / a bank transfer: the money goes back by hand (the dialog says).
//   2. THE CREDIT DOCUMENT in Morning (a real order with an invoice): queued
//      with the refund (or here, for cash / a transfer) and issued NOW — the
//      step waits for Morning's answer. Morning emails it to the orderer's
//      email (client.emails); an order with no email gets it without one.
//   3. THE CANCELLATION: the order `rejected` with the reason, and every
//      active chip issued to it disabled — never deleted — in one transaction
//      (cancelReceptionOrder), with the audit row.
//
// A failed step is stored on the order (cancel_failed_step / cancel_error) and
// the run stops there. "נסה שוב" runs the remaining steps only: a step that is
// done is seen as done (the refund recorded, the credit issued) and skipped.

export interface CancelRun {
  kind: 'done' | 'failed';
  orderNumber: number;
  failedStep: CancelStep | null;
  message: string | null;
  /** How the money went back: through PayPlus now, found already returned in
   *  PayPlus, by hand (cash / a transfer), or not yet (the refund failed). */
  refund: 'refunded' | 'outside' | 'by_hand' | 'none';
  /** The credit document(s) issued (330 + 400 for a 320). */
  creditNumbers: string[];
  /** Whether Morning was asked to email the credit: the address, or no email. */
  creditEmail: { status: 'sent'; to: string } | { status: 'no_email' } | null;
  chipsDisabled: number;
}

type StepResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type ChargeState =
  /** The charge itself was cancelled (voided) in full — no money moved. */
  | { kind: 'cancelled' }
  /** Refund transactions PayPlus holds for the order: `ours` = sent by this
   *  system (more_info "refund:<n>"), otherwise made in PayPlus directly. */
  | { kind: 'refunded'; refunds: { uid: string; amount: number; ours: boolean }[]; total: number }
  /** PayPlus shows the charge and nothing returned. */
  | { kind: 'charged' }
  | { kind: 'unknown'; message: string };

/**
 * What PayPlus shows about a charge right now — READ ONLY, three answers:
 *   · Transactions/View by the charge's uid: transaction_is_cancelled (a
 *     same-day cancellation in the dashboard — documented, seen live 26/11);
 *   · Transactions/View by more_info: ours are sent with "refund:<order
 *     number>"; one made in the dashboard may carry the charge's own
 *     ("<order number>");
 *   · PaymentPages/ipn of the charge's payment session with its related
 *     transactions — a refund PayPlus links to the session itself.
 * Any of them unanswered → unknown (and nothing is sent).
 */
export async function payplusChargeState(
  cfg: PayPlusConfig,
  o: { transactionUid: string; orderNumber: number; pageRequestUid?: string | null },
): Promise<ChargeState> {
  const charge = await viewTransactions(cfg, { transactionUid: o.transactionUid });
  if (charge.kind === 'unknown') return { kind: 'unknown', message: charge.message };
  const own = charge.transactions.find((t) => t.uid === o.transactionUid);
  if (!own) return { kind: 'unknown', message: 'PayPlus did not return the charge' };
  if (own.cancelled) return { kind: 'cancelled' };
  const refunds = new Map<string, { amount: number; ours: boolean }>();
  for (const moreInfo of [`refund:${o.orderNumber}`, String(o.orderNumber)]) {
    const found = await viewTransactions(cfg, { moreInfo });
    if (found.kind === 'unknown') return { kind: 'unknown', message: found.message };
    for (const t of found.transactions) {
      if (t.uid === o.transactionUid || t.cancelled || t.moreInfo !== moreInfo) continue;
      if (!t.type?.includes('refund') || t.statusCode !== '000') continue;
      refunds.set(t.uid, { amount: Math.abs(t.amount), ours: moreInfo.startsWith('refund:') });
    }
  }
  if (o.pageRequestUid) {
    const session = await lookupPaymentRequest(cfg, o.pageRequestUid);
    if (session.kind === 'unknown') return { kind: 'unknown', message: session.message };
    for (const t of session.transactions) {
      if (t.uid === o.transactionUid || refunds.has(t.uid)) continue;
      if (!t.type?.includes('refund') || t.statusCode !== '000') continue;
      refunds.set(t.uid, { amount: Math.abs(t.amount), ours: t.moreInfo === `refund:${o.orderNumber}` });
    }
  }
  if (refunds.size === 0) return { kind: 'charged' };
  const list = [...refunds.entries()].map(([uid, r]) => ({ uid, ...r }));
  return { kind: 'refunded', refunds: list, total: Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100 };
}

const OUTSIDE_NOTE = {
  cancelled: 'העסקה בוטלה ישירות בממשק PayPlus — זוהה ב„ביטול וזיכוי”, ולכן לא נשלח זיכוי נוסף',
  refunded: 'הזיכוי בוצע ישירות בממשק PayPlus — זוהה ב„ביטול וזיכוי”, ולכן לא נשלח זיכוי נוסף',
  /** Our own earlier refund call, whose answer never came, found in PayPlus. */
  ours: 'הזיכוי שנשלח קודם ל-PayPlus (בלי תשובה) נמצא ב-PayPlus ונרשם — לא נשלח זיכוי נוסף',
};

/** What the order holds of its refund right now (after something was recorded). */
async function refundedSoFar(orderId: string): Promise<{ amount: number; via: string | null }> {
  const r = await queryOne<{ amount: number | null; via: string | null }>(
    `select refunded_amount::float8 as amount, refund_via as via from public.chip_orders where id = $1`, [orderId]);
  return { amount: r?.amount ?? 0, via: r?.via ?? null };
}

/** Step 1 — the money of a card. */
async function refundStep(o: CancelTarget, by: { id: string; name: string }): Promise<StepResult<'refunded' | 'outside'>> {
  const paid = o.card_paid_amount ?? o.total;
  if (o.refunded_at && agorot(paid) - agorot(o.refunded_amount ?? 0) <= 0) {
    return { ok: true, value: o.refund_via === 'payplus' ? 'outside' : 'refunded' };
  }
  // (Refunded in part: PayPlus is asked again below — the rest may have been
  // refunded there since; nothing is ever sent for it from here.)
  if (o.refund_call_running) return { ok: false, message: 'בקשת זיכוי נשלחה ל-PayPlus לפני רגע וממתינה לתשובה — נסו שוב בעוד דקה.' };
  if (!o.card_transaction_uid) return { ok: false, message: 'לא נשמר מזהה העסקה של החיוב — יש לזכות ידנית בממשק PayPlus.' };
  const env = o.card_env ?? (o.is_test ? 'sandbox' : 'production');
  const cfg = lookupConfigFor(env);
  if (!cfg) return { ok: false, message: 'PayPlus אינו מוגדר בשרת לסביבה של ההזמנה — לא נשלח זיכוי.' };

  // Is the charge still there? Asked before anything is sent.
  let state: ChargeState;
  try {
    state = await payplusChargeState(cfg, { transactionUid: o.card_transaction_uid, orderNumber: o.order_number, pageRequestUid: o.card_page_request_uid });
  } catch (e) {
    state = { kind: 'unknown', message: (e as Error).name };
  }
  if (state.kind === 'unknown') {
    return { ok: false, message: 'לא ניתן לבדוק כרגע ב-PayPlus אם העסקה כבר זוכתה, ולכן לא נשלח זיכוי. נסו שוב בעוד כמה דקות.' };
  }
  if (state.kind === 'cancelled' || state.kind === 'refunded') {
    const pieces = state.kind === 'cancelled'
      ? [{ uid: `cancelled:${o.card_transaction_uid}`, amount: paid, ours: false }]
      : state.refunds;
    for (const p of pieces) {
      // Recorded once per refund id (recordRefund is idempotent): what was
      // recorded before — a part refunded earlier — is not counted twice.
      const rec = await recordRefund(o.id, p.ours
        ? { refundUid: p.uid, amount: p.amount, via: 'reception_cancel', by, reason: o.reason, closeOpen: false, disableChips: false, note: OUTSIDE_NOTE.ours }
        : { refundUid: p.uid, amount: p.amount, via: 'payplus', by: null, reason: o.reason, closeOpen: false, disableChips: false, note: OUTSIDE_NOTE[state.kind] });
      if (rec.kind === 'refused') {
        return { ok: false, message: `PayPlus מראה ${state.kind === 'cancelled' ? 'ביטול' : 'זיכוי'} שלא תואם להזמנה (${rec.why}) — יש לבדוק בממשק PayPlus.` };
      }
      if (rec.kind === 'recorded' && !p.ours && state.kind === 'refunded' && cfg.mode === 'production') {
        // A refund matched by the order number alone (PayPlus names no
        // charge on it) — a person confirms it in PayPlus, as for a callback.
        await alertChipOrderAdmins({
          orderId: o.id,
          title: `זיכוי מ-PayPlus נקלט — הזמנה ${o.order_number}`,
          message: `ב„ביטול וזיכוי” נמצא ב-PayPlus זיכוי של ${p.amount}₪ (מזהה ${p.uid}) לפי מספר ההזמנה, ולכן לא נשלח זיכוי נוסף. יש לוודא בממשק PayPlus שזה זיכוי של חיוב ההזמנה (מזהה ${o.card_transaction_uid}).`,
          dedupeKey: `chip_refund_payplus:${p.uid}`,
        }).catch(() => undefined);
      }
    }
    const now = await refundedSoFar(o.id);
    if (agorot(now.amount) < agorot(paid)) {
      return { ok: false, message: `PayPlus מראה זיכוי חלקי (${formatIls(now.amount)} מתוך ${formatIls(paid)}). את היתרה מזכים בממשק PayPlus, ואז „נסה שוב”.` };
    }
    return { ok: true, value: now.via === 'payplus' ? 'outside' : 'refunded' };
  }
  // Refunded in part before, and PayPlus shows nothing more: the rest is never sent from here.
  if (o.refunded_at) {
    return { ok: false, message: `ההזמנה זוכתה חלקית (${formatIls(o.refunded_amount ?? 0)} מתוך ${formatIls(paid)}). את היתרה מזכים בממשק PayPlus, ואז „נסה שוב”.` };
  }

  // The charge is there and nothing went back. An earlier call that was never
  // answered may still have refunded: it is never sent a second time.
  if (o.refund_requested_at) {
    return {
      ok: false,
      message: 'בקשת זיכוי קודמת נשלחה ל-PayPlus ולא התקבלה עליה תשובה, ו-PayPlus לא מראה זיכוי. כדי שלא לזכות פעמיים לא נשלח זיכוי נוסף: בדקו בממשק PayPlus — אם הזיכוי לא בוצע, זכו שם, ואז „נסה שוב”.',
    };
  }
  if (!(await markReceptionRefundRequested(o.id))) {
    return { ok: false, message: 'בקשת זיכוי להזמנה כבר בדרך — נסו שוב בעוד דקה.' };
  }
  let res: Awaited<ReturnType<typeof refundByTransactionUid>>;
  try {
    res = await refundByTransactionUid(cfg, { transactionUid: o.card_transaction_uid, amount: paid, moreInfo: `refund:${o.order_number}` });
  } catch (e) {
    res = { kind: 'unknown', status: 0, message: (e as Error).name };
  }
  if (res.kind === 'refunded') {
    try {
      const rec = await recordRefund(o.id, {
        refundUid: res.refundUid, amount: paid, via: 'reception_cancel', by, reason: o.reason, closeOpen: false, disableChips: false,
      });
      if (rec.kind === 'refused') throw new Error(`not recorded: ${rec.why}`);
      return { ok: true, value: 'refunded' };
    } catch (e) {
      // PayPlus REFUNDED and the order does not say so: never refunded again.
      logger.error('[chip-orders] reception cancel: refund confirmed but not recorded', { orderId: o.id, refundUid: res.refundUid, err: (e as Error).message });
      const note = `PayPlus אישר זיכוי (${res.refundUid}) אך רישומו בהזמנה נכשל — אין לזכות שוב; יש לרשום את הזיכוי ידנית`;
      await recordRefundFailure(o.id, note, true).catch(() => undefined);
      if (cfg.mode === 'production') {
        await alertChipOrderAdmins({
          orderId: o.id,
          title: `זיכוי שבוצע ולא נרשם — הזמנה ${o.order_number}`,
          message: `PayPlus אישר זיכוי של ${res.amount}₪ (מזהה הזיכוי ${res.refundUid}) להזמנה ${o.order_number}, אבל רישומו בהזמנה נכשל. אין לזכות שוב — יש לרשום את הזיכוי ידנית.`,
          dedupeKey: `chip_refund_unrecorded:${res.refundUid}`,
        }).catch(() => undefined);
      }
      return { ok: false, message: note };
    }
  }
  if (res.kind === 'refused') {
    const note = `PayPlus סירב לזיכוי: ${res.message}${res.statusCode ? ` (קוד ${res.statusCode})` : ''}`;
    await recordRefundFailure(o.id, note, false);
    return { ok: false, message: note };
  }
  const note = 'לא התקבלה תשובה מ-PayPlus על הזיכוי — יש לבדוק בממשק PayPlus אם הזיכוי בוצע לפני ניסיון נוסף';
  await recordRefundFailure(o.id, note, true);
  await alertChipOrderAdmins({
    orderId: o.id,
    title: `זיכוי בלי תשובה — הזמנה ${o.order_number}`,
    message: `נשלחה בקשת זיכוי ל-PayPlus ולא התקבלה תשובה (${res.message}). יש לבדוק בממשק PayPlus אם הזיכוי בוצע.`,
    dedupeKey: `chip_refund_unknown:${o.id}:${Math.floor(Date.now() / 3_600_000)}`,
  }).catch(() => undefined);
  return { ok: false, message: `${note}.` };
}

/** Step 2 — the credit document, issued now. */
async function creditStep(o: CancelTarget, byName: string): Promise<StepResult<{ numbers: string[]; email: CancelRun['creditEmail'] }>> {
  const none = { ok: true as const, value: { numbers: [] as string[], email: null } };
  if (o.is_test) return none;
  if (o.payment_method === 'cash' || o.payment_method === 'bank_transfer') {
    if (!(await queueReceptionCancelCredit(o.id, o.payment_method, o.total, byName))) return none;
  }
  if (!(await documentRowsOfOrder(o.id)).some((d) => d.kind === 'credit')) {
    // No credit is due: an order with no invoice (recorded before 26/11/2026).
    return none;
  }
  let idle: string | null = null;
  // Twice at most: a credit whose invoice another run was issuing at the same
  // moment waits for it once.
  for (let pass = 0; pass < 2; pass++) {
    await releaseDocumentsOfOrder(o.id);
    const run = await processDueDocuments(10, o.id);
    idle = run.idle;
    const credits = (await documentRowsOfOrder(o.id)).filter((d) => d.kind === 'credit');
    if (credits.every((d) => d.status === 'issued')) {
      const last = credits[credits.length - 1];
      const email = last?.email_status === 'sent' && last.email_to ? { status: 'sent' as const, to: last.email_to }
        : last?.email_status === 'no_email' ? { status: 'no_email' as const } : null;
      return { ok: true, value: { numbers: credits.flatMap((d) => d.numbers), email } };
    }
    if (idle) break;
  }
  if (idle === 'no_key') return { ok: false, message: 'מורנינג לא מחובר (אין מפתח API) — מסמך הזיכוי לא הופק.' };
  if (idle === 'no_document_type') return { ok: false, message: 'מורנינג לא מסר את סוג העסק — מסמך הזיכוי לא הופק.' };
  const docs = await documentRowsOfOrder(o.id);
  const stuck = docs.find((d) => d.status !== 'issued');
  const why = stuck?.last_error ?? (stuck?.kind === 'invoice' ? 'החשבונית המקורית עדיין לא הופקה' : 'מורנינג עוד לא הפיק את המסמך');
  return { ok: false, message: `מסמך הזיכוי לא הופק במורנינג: ${why}` };
}

/**
 * Runs "ביטול וזיכוי" — or what is left of it after a failed step. Null = no
 * such order. Throws ChipOrderStateError when it may not run (not a reception
 * order, already cancelled, running right now, no reason the first time).
 */
export async function runReceptionCancel(orderId: string, reason: string | null, by: { id: string; name: string }): Promise<CancelRun | null> {
  const o = await beginReceptionCancel(orderId, reason, by);
  if (!o) return null;
  const run: CancelRun = {
    kind: 'failed', orderNumber: o.order_number, failedStep: null, message: null,
    refund: 'none', creditNumbers: [], creditEmail: null, chipsDisabled: 0,
  };
  const stop = async (step: CancelStep, message: string): Promise<CancelRun> => {
    await failReceptionCancel(orderId, step, message, by, o.lease);
    return { ...run, failedStep: step, message };
  };

  try {
    // 1 — the refund.
    if (o.payment_method === 'card' && o.card_status === 'paid') {
      const r = await refundStep(o, by);
      if (!r.ok) return await stop('refund', r.message);
      run.refund = r.value;
    } else {
      run.refund = 'by_hand';
    }
    // 2 — the credit document.
    const c = await creditStep(o, by.name);
    if (!c.ok) return await stop('credit', c.message);
    run.creditNumbers = c.value.numbers;
    run.creditEmail = c.value.email;
    // 3 — the cancellation and the chips.
    let done: Awaited<ReturnType<typeof cancelReceptionOrder>>;
    try {
      done = await cancelReceptionOrder(orderId, o.reason, by, {
        refund: run.refund, credit_numbers: run.creditNumbers, credit_email: run.creditEmail?.status ?? null,
      });
    } catch (e) {
      logger.error('[chip-orders] reception cancel: the cancellation step failed', { orderId, err: (e as Error).message });
      return await stop('cancel', 'ביטול ההזמנה והשבתת הצ׳יפים נכשלו — נסו שוב.');
    }
    if (!done) return await stop('cancel', 'ההזמנה לא נמצאה.');
    return { ...run, kind: 'done', chipsDisabled: done.chips_disabled };
  } catch (e) {
    // Anything unexpected: the order says where it stopped.
    logger.error('[chip-orders] reception cancel failed', { orderId, err: (e as Error).message });
    const step: CancelStep = run.refund === 'none' && o.payment_method === 'card' ? 'refund' : 'credit';
    return await stop(step, 'השלב נכשל בשגיאה לא צפויה — נסו שוב.');
  }
}

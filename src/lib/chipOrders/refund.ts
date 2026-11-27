import 'server-only';
import { logger } from '@/lib/logger';
import { query, queryOne, withTransaction } from '@/lib/db';
import { writeAuditInTx } from '@/lib/db/audit';
import {
  lookupPaymentRequest, refundByTransactionUid, viewTransactions, type PayPlusConfig, type PayPlusTransaction,
} from '@/lib/payplus/client';
import { REFUND_CALL_SECONDS, recordRefund, recordRefundFailure, type RefundTarget, type RefundVia } from '@/lib/db/chipOrderRefund';
import { agorot } from '@/lib/db/chipOrderCard';
import { formatIls } from './model';
import { PAYPLUS_REVERSAL_LABEL } from './receptionCancelText';
import { lookupConfigFor } from './cardPayment';
import { alertChipOrderAdmins } from './alerts';

// Chip orders — THE refund of a card payment through PayPlus (27/11/2026).
//
// ONE IMPLEMENTATION, used everywhere a card payment goes back: "ביטול
// וזיכוי" of any order (src/lib/chipOrders/receptionCancel.ts — a reception
// order, and a web order, where it replaced "זיכוי"), and "דחה" of a web order
// the card paid (it runs the same steps). Until 27/11/2026 "זיכוי" and "דחה"
// had a path of their own that sent the refund again once ten minutes had
// passed without an answer — that path is gone.
//
// refundCharge, in this order:
//   1. Refunded in full already (recorded) → done, nothing is sent.
//   2. PayPlus is asked FIRST, read only (payplusChargeState): the charge
//      cancelled (voided the same day — in its dashboard, or a refund PayPlus
//      turned into a cancellation, seen live 26/11/2026) or refunded there →
//      no refund is sent; what PayPlus shows is recorded, with a note.
//      PayPlus cannot be asked → nothing is sent (try again later).
//   3. A refund call was sent before and its answer never came, and PayPlus
//      shows nothing → NEVER sent again: a person checks PayPlus (and refunds
//      there when it did not go through), then "נסה שוב" finds it.
//   4. Otherwise ONE full refund (Transactions/RefundByTransactionUID), marked
//      as sent before the call; PayPlus's answer is recorded with the order,
//      its credit document and the audit row in one transaction (recordRefund).
//
// checkPaidOrderReversal: a signed PayPlus callback for an order that is
// ALREADY paid — a cancellation in the dashboard arrives looking exactly like
// the original charge (26/11/2026), a dashboard refund as a "Refund". Either
// way PayPlus is asked what it shows now; a cancellation or a refund the order
// does not record is NOT recorded and gets NO Morning document: the order is
// marked "בוטל ב-PayPlus — נדרש ביטול וזיכוי" and every admin is told, so a
// person finishes it with "ביטול וזיכוי".

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
 *     same-day cancellation — documented, seen live 26/11/2026);
 *   · Transactions/View by more_info: ours are sent with "refund:<order
 *     number>"; one made in the dashboard may carry the charge's own
 *     ("<order number>");
 *   · PaymentPages/ipn of the charge's payment session with its related
 *     transactions — a refund PayPlus links to the session itself.
 * Any of them unanswered → unknown (and nothing is sent). `sessionOptional`
 * (the warning of a callback only — never before a refund): the session's
 * own answer, when it gives none, does not make the whole answer unknown.
 */
export async function payplusChargeState(
  cfg: PayPlusConfig,
  o: { transactionUid: string; orderNumber: number; pageRequestUid?: string | null },
  opts: { sessionOptional?: boolean } = {},
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
    if (session.kind === 'unknown' && !opts.sessionOptional) return { kind: 'unknown', message: session.message };
    for (const t of session.kind === 'unknown' ? [] : session.transactions) {
      if (t.uid === o.transactionUid || refunds.has(t.uid)) continue;
      if (!t.type?.includes('refund') || t.statusCode !== '000') continue;
      refunds.set(t.uid, { amount: Math.abs(t.amount), ours: t.moreInfo === `refund:${o.orderNumber}` });
    }
  }
  if (refunds.size === 0) return { kind: 'charged' };
  const list = [...refunds.entries()].map(([uid, r]) => ({ uid, ...r }));
  return { kind: 'refunded', refunds: list, total: Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100 };
}

export type RefundStep = { ok: true; value: 'refunded' | 'outside' } | { ok: false; message: string };

const OUTSIDE_NOTE = {
  cancelled: 'העסקה בוטלה ישירות בממשק PayPlus — זוהה לפני שליחת הזיכוי, ולכן לא נשלח זיכוי נוסף',
  refunded: 'הזיכוי בוצע ישירות בממשק PayPlus — זוהה לפני שליחת הזיכוי, ולכן לא נשלח זיכוי נוסף',
  /** Our own earlier refund call, whose answer never came, found in PayPlus. */
  ours: 'הזיכוי שנשלח קודם ל-PayPlus (בלי תשובה) נמצא ב-PayPlus ונרשם — לא נשלח זיכוי נוסף',
};

/** What the order holds of its refund right now (after something was recorded). */
async function refundedSoFar(orderId: string): Promise<{ amount: number; via: string | null }> {
  const r = await queryOne<{ amount: number | null; via: string | null }>(
    `select refunded_amount::float8 as amount, refund_via as via from public.chip_orders where id = $1`, [orderId]);
  return { amount: r?.amount ?? 0, via: r?.via ?? null };
}

/** Marks the refund call as sent, right before it is made — only when no
 *  earlier call is unanswered and the order was not refunded. False = refuse
 *  to call (another call is out, or the order was refunded meanwhile). */
async function markRefundRequested(orderId: string): Promise<boolean> {
  const r = await query(
    `update public.chip_orders set refund_requested_at = now(), updated_at = now()
      where id = $1 and refunded_at is null and refund_requested_at is null and card_status = 'paid'`,
    [orderId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * THE refund of an order's card charge (see the header). `via` names the
 * action it runs for; `by` the admin / staff member. Never throws for PayPlus
 * (its silence is an answer here); a database error does throw.
 */
export async function refundCharge(
  o: RefundTarget,
  ctx: { via: Exclude<RefundVia, 'payplus'>; by: { id: string; name: string } },
): Promise<RefundStep> {
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
        ? { refundUid: p.uid, amount: p.amount, via: ctx.via, by: ctx.by, reason: o.reason, note: OUTSIDE_NOTE.ours }
        : { refundUid: p.uid, amount: p.amount, via: 'payplus', by: null, reason: o.reason, note: OUTSIDE_NOTE[state.kind] });
      if (rec.kind === 'refused') {
        return { ok: false, message: `PayPlus מראה ${state.kind === 'cancelled' ? 'ביטול' : 'זיכוי'} שלא תואם להזמנה (${rec.why}) — יש לבדוק בממשק PayPlus.` };
      }
      if (rec.kind === 'recorded' && !p.ours && state.kind === 'refunded' && cfg.mode === 'production') {
        // A refund matched by the order number alone (PayPlus names no
        // charge on it) — a person confirms it in PayPlus.
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
  // answered may still have refunded: it is never sent a second time — not
  // after ten minutes, not ever.
  if (o.refund_requested_at) {
    return {
      ok: false,
      message: 'בקשת זיכוי קודמת נשלחה ל-PayPlus ולא התקבלה עליה תשובה, ו-PayPlus לא מראה זיכוי. כדי שלא לזכות פעמיים לא נשלח זיכוי נוסף: בדקו בממשק PayPlus — אם הזיכוי לא בוצע, זכו שם, ואז „נסה שוב”.',
    };
  }
  if (!(await markRefundRequested(o.id))) {
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
        refundUid: res.refundUid, amount: paid, via: ctx.via, by: ctx.by, reason: o.reason,
      });
      if (rec.kind === 'refused') throw new Error(`not recorded: ${rec.why}`);
      return { ok: true, value: 'refunded' };
    } catch (e) {
      // PayPlus REFUNDED and the order does not say so: never refunded again.
      logger.error('[chip-orders] refund confirmed but not recorded', { orderId: o.id, refundUid: res.refundUid, err: (e as Error).message });
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

// ── A cancellation or a refund made in PayPlus ──────────────────────────────

export type ReversalCheck =
  /** PayPlus shows the charge cancelled / refunded and the order does not record it: marked. */
  | { kind: 'flagged'; orderId: string; reversal: 'cancelled' | 'refunded' | 'partial'; first: boolean }
  /** Nothing to mark: PayPlus shows the charge as it is, or the order already records it. */
  | { kind: 'none' }
  /** PayPlus could not be asked now, or our own refund call may still be
   *  answered — the caller answers 503 so PayPlus sends the notice again. */
  | { kind: 'later' }
  | { kind: 'ignored'; why: string };

/** The order number a notice carries: "<n>" (a charge, or a refund made in the
 *  dashboard) or "refund:<n>" (ours). */
export function noticeOrderNumber(moreInfo: string | null): number | null {
  const m = moreInfo ? /^(?:refund:)?(\d{1,9})$/.exec(moreInfo) : null;
  return m ? Number(m[1]) : null;
}

/**
 * A validated PayPlus callback named this order (see the header). Only an
 * order that is ALREADY paid by card, of the notice's own environment, with
 * no "ביטול וזיכוי" finished, is looked at; PayPlus is asked what it shows
 * now. A cancellation or a refund beyond what the order records → the order
 * carries the warning (payplus_reversal_at / _kind) — nothing is recorded,
 * nothing is sent to Morning — and every admin is told once.
 */
export async function checkPaidOrderReversal(cfg: PayPlusConfig, orderNumber: number): Promise<ReversalCheck> {
  const o = await queryOne<{
    id: string; order_number: number; is_test: boolean; card_env: 'sandbox' | 'production' | null; card_status: string | null;
    card_transaction_uid: string | null; card_page_request_uid: string | null; card_paid_amount: number | null;
    refunded_amount: number | null; call_running: boolean; cancel_completed_at: string | null; source: string; status: string;
  }>(
    `select id, order_number, is_test, card_env, card_status, card_transaction_uid, card_page_request_uid, source, status,
            card_paid_amount::float8 as card_paid_amount, refunded_amount::float8 as refunded_amount,
            (refund_requested_at is not null and refunded_at is null
              and refund_requested_at > now() - make_interval(secs => $2)) as call_running,
            cancel_completed_at
       from public.chip_orders where order_number = $1`,
    [orderNumber, REFUND_CALL_SECONDS],
  );
  if (!o) return { kind: 'ignored', why: 'unknown_order' };
  if ((o.card_env ?? (o.is_test ? 'sandbox' : 'production')) !== cfg.mode || o.is_test !== (cfg.mode === 'sandbox')) {
    return { kind: 'ignored', why: 'wrong_environment' };
  }
  if (o.card_status !== 'paid' || !o.card_transaction_uid || o.card_paid_amount === null) return { kind: 'ignored', why: 'not_paid' };
  if (o.cancel_completed_at) return { kind: 'none' };
  // A reception order cancelled before "ביטול וזיכוי" existed: nothing can finish it.
  if (o.source === 'reception' && o.status === 'rejected') return { kind: 'none' };
  const recorded = o.refunded_amount ?? 0;
  if (agorot(recorded) >= agorot(o.card_paid_amount)) return { kind: 'none' };
  // Our own refund call may still be answered: its answer records it.
  if (o.call_running) return { kind: 'later' };

  let state: ChargeState;
  try {
    state = await payplusChargeState(
      cfg,
      { transactionUid: o.card_transaction_uid, orderNumber: o.order_number, pageRequestUid: o.card_page_request_uid },
      { sessionOptional: true },
    );
  } catch (e) {
    state = { kind: 'unknown', message: (e as Error).name };
  }
  if (state.kind === 'unknown') {
    logger.warn('[chip-orders] payplus callback of a paid order: PayPlus could not be asked', { orderId: o.id, message: state.message });
    return { kind: 'later' };
  }
  if (state.kind === 'charged') return { kind: 'none' };
  // Only refunds this system sent (more_info "refund:<n>" — one whose answer
  // was lost): not something done in PayPlus. The order already says its
  // refund is on its way, and "ביטול וזיכוי" records it.
  if (state.kind === 'refunded' && state.refunds.every((r) => r.ours)) return { kind: 'none' };
  let reversal: 'cancelled' | 'refunded' | 'partial';
  if (state.kind === 'cancelled') reversal = 'cancelled';
  else if (agorot(state.total) <= agorot(recorded)) return { kind: 'none' };
  else reversal = agorot(state.total) >= agorot(o.card_paid_amount) ? 'refunded' : 'partial';

  const first = await withTransaction(async (client) => {
    const now = (
      await client.query<{ seen: boolean }>(
        `select payplus_reversal_at is not null as seen from public.chip_orders
          where id = $1 and card_status = 'paid' and cancel_completed_at is null for update`,
        [o.id],
      )
    ).rows[0];
    if (!now) return null;
    await client.query(
      `update public.chip_orders
          set payplus_reversal_at = coalesce(payplus_reversal_at, now()), payplus_reversal_kind = $2, updated_at = now()
        where id = $1`,
      [o.id, reversal],
    );
    const row = { first: !now.seen };
    if (row.first) {
      await writeAuditInTx(client, {
        actorUserId: null,
        action: 'payplus_reversal_seen',
        entityType: 'chip_order',
        entityId: o.id,
        metadata: {
          order_number: o.order_number, reversal, env: cfg.mode, transaction_uid: o.card_transaction_uid,
          ...(state.kind === 'refunded' ? { refunds: state.refunds.map((x) => ({ uid: x.uid, amount: x.amount, ours: x.ours })) } : {}),
        },
      });
    }
    return row.first;
  });
  if (first === null) return { kind: 'none' };
  if (first && cfg.mode === 'production') {
    const what = reversal === 'cancelled' ? 'בוטל' : reversal === 'refunded' ? 'זוכה במלואו' : 'זוכה בחלקו';
    await alertChipOrderAdmins({
      orderId: o.id,
      title: `${PAYPLUS_REVERSAL_LABEL} — הזמנה ${o.order_number}`,
      message: `PayPlus מראה שהחיוב של הזמנה ${o.order_number} ${what} ישירות ב-PayPlus. לא נרשם זיכוי ולא הופק מסמך במורנינג: יש להשלים ב„ביטול וזיכוי” — לא יישלח זיכוי נוסף.`,
      dedupeKey: `chip_payplus_reversal:${o.id}`,
    }).catch(() => undefined);
  }
  return { kind: 'flagged', orderId: o.id, reversal, first };
}

/**
 * A REFUND PayPlus reported (transaction_type Refund, signature checked): ours
 * echoed back (its id is on the order) → nothing; otherwise the order it names
 * is checked as any callback of a paid order is (checkPaidOrderReversal) — the
 * refund is never recorded from the notice itself.
 */
export async function applyPayPlusRefundNotice(cfg: PayPlusConfig, tx: PayPlusTransaction): Promise<ReversalCheck | { kind: 'already' }> {
  if (tx.statusCode !== '000') return { kind: 'ignored', why: 'refund_not_approved' };
  const known = await queryOne<{ id: string }>(`select id from public.chip_orders where refund_transaction_uid = $1`, [tx.uid]);
  if (known) return { kind: 'already' };
  const orderNumber = noticeOrderNumber(tx.moreInfo);
  if (orderNumber === null) {
    if (cfg.mode === 'production') {
      await alertChipOrderAdmins({
        orderId: null,
        title: 'זיכוי ב-PayPlus שלא שויך להזמנה',
        message: `PayPlus דיווח על זיכוי של ${Math.abs(tx.amount)}₪ (מזהה ${tx.uid}) בלי מספר הזמנה. אם הוא שייך להזמנת צ׳יפים — יש לבדוק אותה ב-PayPlus ולהשלים ב„ביטול וזיכוי”.`,
        dedupeKey: `chip_refund_unmatched:${tx.uid}`,
      });
    }
    return { kind: 'ignored', why: 'no_order_number' };
  }
  return checkPaidOrderReversal(cfg, orderNumber);
}

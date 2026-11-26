import 'server-only';
import { logger } from '@/lib/logger';
import { cancelReceptionOrder } from '@/lib/db/chipOrders';
import { releaseDocumentsOfOrder } from '@/lib/db/chipOrderDocuments';
import {
  beginCancelAndCredit, documentRowsOfOrder, failCancelStep, finishWebCancel, queueReceptionCancelCredit,
  type CancelStep, type CancelTarget,
} from '@/lib/db/chipReceptionCancel';
import { processDueDocuments } from './documents';
import { refundCharge } from './refund';

// "ביטול וזיכוי" (27/11/2026 — what the first real ₪1 charges of 26/11/2026
// exposed: there was no way to undo a paid reception order from where it is
// shown, a refund made in the PayPlus dashboard left the order "paid" with no
// credit document, and the web order's "זיכוי" could send a second refund).
// THE way back for every order — a reception order (collected, or paid by card
// with its chips never saved) and a web order the card paid; "דחה" of such a
// web order runs it too. Admin and super admin (the route); "דחה" keeps its
// own permission. The steps, IN THIS ORDER — each one only after the one
// before it:
//
//   1. THE REFUND (a card): refundCharge (src/lib/chipOrders/refund.ts — the
//      one refund of the module): PayPlus is asked FIRST, read only, whether
//      the charge is still there; cancelled or refunded there → nothing is
//      sent, it is recorded as made "בממשק PayPlus"; otherwise one full refund.
//      A refund whose answer never came is NEVER sent again.
//      Cash / a bank transfer (reception): the money goes back by hand.
//   2. THE CREDIT DOCUMENT in Morning (a real order with an invoice): queued
//      with the refund (or here, for cash / a transfer) and issued NOW — the
//      step waits for Morning's answer. Morning emails it to the orderer's
//      email (client.emails); an order with no email gets it without one.
//   3. THE CANCELLATION, in one transaction with the audit row: every active
//      chip issued to the order disabled — never deleted — and the order
//      `rejected` (a reception order: cancelReceptionOrder; a web order:
//      finishWebCancel), the run finished and a PayPlus warning cleared.
//
// A failed step is stored on the order (cancel_failed_step / cancel_error) and
// the run stops there. "נסה שוב" runs the remaining steps only: a step that is
// done is seen as done (the refund recorded, the credit issued) and skipped.

export interface CancelRun {
  kind: 'done' | 'failed';
  orderNumber: number;
  source: 'web' | 'reception';
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
 * such order. Throws ChipOrderStateError when it may not run (cancelRefusal:
 * finished already, a reception order not collected, a web order not paid by
 * card; running right now; no reason the first time). `via` — the action that
 * runs it: "ביטול וזיכוי" (admin), or "דחה" of a web order the card paid.
 */
export async function runCancelAndCredit(
  orderId: string,
  reason: string | null,
  by: { id: string; name: string },
  via: 'cancel' | 'reject' = 'cancel',
): Promise<CancelRun | null> {
  const o = await beginCancelAndCredit(orderId, reason, by);
  if (!o) return null;
  const run: CancelRun = {
    kind: 'failed', orderNumber: o.order_number, source: o.source, failedStep: null, message: null,
    refund: 'none', creditNumbers: [], creditEmail: null, chipsDisabled: 0,
  };
  const stop = async (step: CancelStep, message: string): Promise<CancelRun> => {
    await failCancelStep(orderId, step, message, by, o.lease);
    return { ...run, failedStep: step, message };
  };
  const cardPaid = o.card_status === 'paid' && (o.source === 'web' || o.payment_method === 'card');

  try {
    // 1 — the refund.
    if (cardPaid) {
      const r = await refundCharge(o, {
        via: o.source === 'reception' ? 'reception_cancel' : via === 'reject' ? 'reject' : 'admin',
        by,
      });
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
    const summary = { refund: run.refund, credit_numbers: run.creditNumbers, credit_email: run.creditEmail?.status ?? null };
    let done: { chips_disabled: number } | null;
    try {
      done = o.source === 'reception'
        ? await cancelReceptionOrder(orderId, o.reason, by, summary)
        : await finishWebCancel(orderId, o.reason, by, summary);
    } catch (e) {
      logger.error('[chip-orders] cancel and credit: the cancellation step failed', { orderId, err: (e as Error).message });
      return await stop('cancel', 'ביטול ההזמנה והשבתת הצ׳יפים נכשלו — נסו שוב.');
    }
    if (!done) return await stop('cancel', 'ההזמנה לא נמצאה.');
    return { ...run, kind: 'done', chipsDisabled: done.chips_disabled };
  } catch (e) {
    // Anything unexpected: the order says where it stopped.
    logger.error('[chip-orders] cancel and credit failed', { orderId, err: (e as Error).message });
    const step: CancelStep = run.refund === 'none' && cardPaid ? 'refund' : 'credit';
    return await stop(step, 'השלב נכשל בשגיאה לא צפויה — נסו שוב.');
  }
}

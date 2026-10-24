import 'server-only';
import { findDocument, claimDueNotices, getRfqAnswerStats } from '@/lib/db/purchasing';
import { createNotification } from '@/services/notifications';
import { todayInJerusalem } from '@/lib/dates';
import { logger } from '@/lib/logger';

// Purchasing → the creator of a request hears about its quotes: the bell (in-app
// row) and, per the recipient's own e-mail opt-in, an e-mail — both through the
// registry-driven createNotification, so no new transport exists. Nothing here
// ever throws to the caller: a failed notice must not fail the supplier's
// submission or the cron run.

const rfqUrl = (id: string) => `/purchasing?tab=rfq&open=${id}`;
const subject = (number: number | null, title: string) => `בקשה ${number ?? ''}${title ? ` — ${title}` : ''}`;

/** A supplier submitted a quote through its link (or amended it). `quoteStamp`
 *  is the quote's updated_at — an amendment is a new notice, a repeated call
 *  with the same stamp is not. */
export async function notifyQuoteSubmitted(input: {
  rfqId: string; quoteId: string; quoteStamp: string; supplierName: string; isUpdate: boolean;
}): Promise<void> {
  try {
    const doc = await findDocument(input.rfqId);
    if (!doc || !doc.created_by) return;
    const what = input.isUpdate ? 'עדכן את הצעת המחיר' : 'הגיש הצעת מחיר';
    await createNotification({
      userId: doc.created_by,
      type: 'purchasing_quote_received',
      title: input.isUpdate ? 'הצעת מחיר עודכנה' : 'התקבלה הצעת מחיר',
      message: `${subject(doc.number, doc.title)}: ${input.supplierName} ${what}.`,
      sourceEntityType: 'purchasing_document',
      sourceEntityId: doc.id,
      actionUrl: rfqUrl(doc.id),
      dedupeKey: `purchasing_quote:${input.quoteId}:${new Date(input.quoteStamp).getTime()}`,
    });
    if (input.isUpdate) return;
    const stats = await getRfqAnswerStats(doc.id);
    if (stats.recipients > 0 && stats.answered >= stats.recipients) {
      await createNotification({
        userId: doc.created_by,
        type: 'purchasing_quotes_complete',
        title: 'כל הספקים הגישו הצעה',
        message: `${subject(doc.number, doc.title)}: התקבלו ${stats.answered} מתוך ${stats.recipients} הצעות.`,
        sourceEntityType: 'purchasing_document',
        sourceEntityId: doc.id,
        actionUrl: rfqUrl(doc.id),
        dedupeKey: `purchasing_complete:${doc.id}:${input.quoteId}`,
      });
    }
  } catch (err) {
    logger.error('[purchasing] quote notice failed', err);
  }
}

/** The cron pass: each request whose due date has passed gets ONE notice with
 *  the final tally. Returns how many requests were announced. */
export async function notifyDueDatesPassed(): Promise<number> {
  let sent = 0;
  try {
    for (const rfq of await claimDueNotices(todayInJerusalem())) {
      if (!rfq.created_by) continue;
      const stats = await getRfqAnswerStats(rfq.id);
      await createNotification({
        userId: rfq.created_by,
        type: 'purchasing_rfq_closed',
        title: 'עבר יעד ההגשה',
        message: `${subject(rfq.number, rfq.title)}: עבר יעד ההגשה — התקבלו ${stats.answered} מתוך ${stats.recipients} הצעות.`,
        sourceEntityType: 'purchasing_document',
        sourceEntityId: rfq.id,
        actionUrl: rfqUrl(rfq.id),
        dedupeKey: `purchasing_due:${rfq.id}`,
      });
      sent++;
    }
  } catch (err) {
    logger.error('[purchasing] due-date notices failed', err);
  }
  return sent;
}

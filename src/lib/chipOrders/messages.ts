import { CHIP_ORDER_REFUND_LABEL, CHIP_ORDER_TEST_LABEL, type ChipOrderNotifyKind, type ChipOrderRefundStatus } from './model';

// The three messages a resident gets about a chip order — one wording for
// both channels (the email wraps it in the standard frame, WhatsApp sends it
// as text). Pure: the caller resolves dates and links. (The "approved" message
// went with the approval step on 13/11/2026; the "received & paid" message now
// carries the due date it used to send.)

export interface ChipOrderMessageInput {
  kind: ChipOrderNotifyKind;
  fullName: string;
  orderNumber: number;
  apartments: string[];
  trackUrl: string;
  /** Already formatted (he-IL, Asia/Jerusalem) — paid only. */
  dueText?: string | null;
  /** From the settings — ready only. */
  pickupText?: string | null;
  /** Rejected only. */
  rejectReason?: string | null;
  refundStatus?: ChipOrderRefundStatus | null;
  /** Refunded only — how much went back. */
  refundedAmount?: number | null;
  /** Refunded only — the order was closed with the refund (it was not collected yet). */
  closedByRefund?: boolean;
  /** Refunded only — the refund disabled chips of the order. A refund PayPlus
   *  reported (made in its dashboard) disables none: then nothing is said
   *  about the chips. */
  chipsDisabled?: boolean;
  /** The Morning document's link, when it was issued already — linked, never copied. */
  invoiceUrl?: string | null;
  /** The receipt will reach the customer by email (Morning is connected and
   *  the order has an email) — the message says so only when it is true. */
  receiptByEmail?: boolean;
  /** A test-mode order: every message starts with "[בדיקה]", never mentions an
   *  invoice, and a rejection says nothing was charged. */
  isTest?: boolean;
}

export interface ChipOrderMessage {
  subject: string;
  /** Paragraphs, in order. */
  lines: string[];
  /** The only URLs an email may turn into links: ours and Morning's document.
   *  Anything URL-like the resident typed (a name) stays plain text. */
  links: string[];
}

export function chipOrderMessage(m: ChipOrderMessageInput): ChipOrderMessage {
  const test = m.isTest === true;
  const invoiceUrl = test ? null : (m.invoiceUrl ?? null);
  const links = [m.trackUrl, ...(invoiceUrl ? [invoiceUrl] : [])];
  const apts = m.apartments.length === 1 ? `דירה ${m.apartments[0]}` : `דירות ${m.apartments.join(', ')}`;
  const ref = `הזמנה מספר ${m.orderNumber} (${apts})`;
  const msg = ((): Omit<ChipOrderMessage, 'links'> => {
  switch (m.kind) {
    case 'paid':
      return {
        subject: `הזמנת הצ׳יפים התקבלה — הזמנה ${m.orderNumber}`,
        lines: [
          `שלום ${m.fullName},`,
          `${ref} התקבלה והתשלום נקלט. ההזמנה נמצאת בהכנה.`,
          ...(m.dueText ? [`מועד היעד להכנה: ${m.dueText}.`] : []),
          'נעדכן אותך כשהצ׳יפים יהיו מוכנים לאיסוף.',
          ...(test
            ? []
            : invoiceUrl ? [`החשבונית / הקבלה: ${invoiceUrl}`] : m.receiptByEmail ? ['החשבונית / הקבלה תישלח אליך במייל בנפרד.'] : []),
          `מעקב אחרי ההזמנה: ${m.trackUrl}`,
        ],
      };
    case 'ready':
      return {
        subject: `הצ׳יפים מוכנים לאיסוף — הזמנה ${m.orderNumber}`,
        lines: [
          `שלום ${m.fullName},`,
          `הצ׳יפים של ${ref} מוכנים לאיסוף.`,
          ...(m.pickupText?.trim() ? [`מקום ושעות האיסוף: ${m.pickupText.trim()}`] : []),
          `מעקב אחרי ההזמנה: ${m.trackUrl}`,
        ],
      };
    case 'refunded':
      return {
        subject: `הזמנת הצ׳יפים זוכתה — הזמנה ${m.orderNumber}`,
        lines: [
          `שלום ${m.fullName},`,
          test
            ? `${ref} זוכתה (הזמנת בדיקה — לא בוצע חיוב אמיתי).`
            : `${ref} זוכתה: ${m.refundedAmount ? `₪${m.refundedAmount}` : 'התשלום'} הוחזר לכרטיס שבו שילמת. ההחזר יופיע בחשבון לפי מועדי חברת האשראי.`,
          ...(m.closedByRefund ? ['ההזמנה בוטלה.'] : m.chipsDisabled ? ['הצ׳יפים של ההזמנה הושבתו.'] : []),
          `מעקב אחרי ההזמנה: ${m.trackUrl}`,
        ],
      };
    case 'rejected':
      return {
        subject: `הזמנת הצ׳יפים נדחתה — הזמנה ${m.orderNumber}`,
        lines: [
          `שלום ${m.fullName},`,
          `${ref} נדחתה.`,
          ...(m.rejectReason?.trim() ? [`הסיבה: ${m.rejectReason.trim()}`] : []),
          test || m.refundStatus === 'not_required'
            ? 'זו הזמנת בדיקה: לא בוצע חיוב, ולכן אין זיכוי.'
            : m.refundStatus === 'refunded'
            ? 'התשלום זוכה במלואו לאמצעי התשלום שבו שילמת.'
            : m.refundStatus === 'manual_required'
              ? `מצב הזיכוי: ${CHIP_ORDER_REFUND_LABEL.manual_required} — חברת הניהול תטפל בהחזר התשלום ותעדכן אותך.`
              : 'חברת הניהול תעדכן אותך לגבי החזר התשלום.',
          `מעקב אחרי ההזמנה: ${m.trackUrl}`,
        ],
      };
  }
  })();
  if (!test) return { ...msg, links };
  const mark = `[${CHIP_ORDER_TEST_LABEL}]`;
  return {
    subject: `${mark} ${msg.subject}`,
    lines: [`${mark} ${msg.lines[0] ?? ''}`.trim(), ...msg.lines.slice(1)],
    links,
  };
}

/** WhatsApp body — the same paragraphs, blank line between them. */
export function chipOrderWhatsAppText(msg: ChipOrderMessage): string {
  return msg.lines.join('\n\n');
}

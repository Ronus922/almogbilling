import { CHIP_ORDER_REFUND_LABEL, CHIP_ORDER_TEST_LABEL, type ChipOrderNotifyKind, type ChipOrderRefundStatus } from './model';

// The four messages a resident gets about a chip order — one wording for both
// channels (the email wraps it in the standard frame, WhatsApp sends it as
// text). Pure: the caller resolves dates and links.

export interface ChipOrderMessageInput {
  kind: ChipOrderNotifyKind;
  fullName: string;
  orderNumber: number;
  apartments: string[];
  trackUrl: string;
  /** Already formatted (he-IL, Asia/Jerusalem) — approved only. */
  dueText?: string | null;
  /** From the settings — ready only. */
  pickupText?: string | null;
  /** Rejected only. */
  rejectReason?: string | null;
  refundStatus?: ChipOrderRefundStatus | null;
  /** Grow's invoice / receipt — linked, never copied. */
  invoiceUrl?: string | null;
  /** A test-mode order: every message starts with "[בדיקה]", never mentions an
   *  invoice, and a rejection says nothing was charged. */
  isTest?: boolean;
}

export interface ChipOrderMessage {
  subject: string;
  /** Paragraphs, in order. */
  lines: string[];
  /** The only URLs an email may turn into links: ours and Grow's document.
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
          `${ref} התקבלה והתשלום נקלט. ההזמנה ממתינה לבדיקה של חברת הניהול.`,
          ...(test
            ? []
            : invoiceUrl ? [`החשבונית / הקבלה: ${invoiceUrl}`] : ['החשבונית / הקבלה נשלחת אליך בנפרד מחברת הסליקה.']),
          `מעקב אחרי ההזמנה: ${m.trackUrl}`,
        ],
      };
    case 'approved':
      return {
        subject: `הזמנת הצ׳יפים אושרה — הזמנה ${m.orderNumber}`,
        lines: [
          `שלום ${m.fullName},`,
          `${ref} אושרה ונמצאת בהכנה.`,
          ...(m.dueText ? [`מועד היעד להכנה: ${m.dueText}.`] : []),
          'נעדכן אותך כשהצ׳יפים יהיו מוכנים לאיסוף.',
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

// "ביטול וזיכוי" (27/11/2026) — the words, shared by the confirmation
// (src/components/chips/ReceptionCancelDialog.tsx), the places that open it,
// the server and the tests. No I/O.

import { formatIlsAfter } from './model';

export const RECEPTION_CANCEL_LABEL = 'ביטול וזיכוי';

/** A paid order whose charge PayPlus shows cancelled / refunded (a signed
 *  callback, then PayPlus asked) while the order records no such refund. */
export const PAYPLUS_REVERSAL_LABEL = 'בוטל ב-PayPlus — נדרש ביטול וזיכוי';

/** What PayPlus showed, in a sentence (the order's window and the confirmation). */
export const PAYPLUS_REVERSAL_TEXT: Record<'cancelled' | 'refunded' | 'partial', string> = {
  cancelled: 'PayPlus מראה שהעסקה בוטלה ישירות בממשק PayPlus. ההזמנה עוד לא רושמת זאת, ולא הופק עליו מסמך זיכוי במורנינג.',
  refunded: 'PayPlus מראה שהעסקה זוכתה ישירות בממשק PayPlus. ההזמנה עוד לא רושמת זאת, ולא הופק עליו מסמך זיכוי במורנינג.',
  partial: 'PayPlus מראה זיכוי חלקי של העסקה ישירות בממשק PayPlus. ההזמנה עוד לא רושמת אותו, ולא הופק עליו מסמך זיכוי במורנינג.',
};

/** What "ביטול וזיכוי" will do with it (for an admin). */
export const PAYPLUS_REVERSAL_NEXT: Record<'cancelled' | 'refunded' | 'partial', string> = {
  cancelled: '„ביטול וזיכוי” ירשום זאת, יפיק את מסמך הזיכוי וישלים את ההזמנה — בלי לשלוח זיכוי נוסף.',
  refunded: '„ביטול וזיכוי” ירשום זאת, יפיק את מסמך הזיכוי וישלים את ההזמנה — בלי לשלוח זיכוי נוסף.',
  partial: 'את היתרה מזכים בממשק PayPlus, ואז „ביטול וזיכוי” ירשום את הזיכויים וישלים את ההזמנה — מכאן לא יישלח זיכוי.',
};

export type ReceptionCancelStep = 'refund' | 'credit' | 'cancel';

/** The step a stopped "ביטול וזיכוי" stopped at, as the order names it. */
export const RECEPTION_CANCEL_STEP_LABEL: Record<ReceptionCancelStep, string> = {
  refund: 'הזיכוי ב-PayPlus',
  credit: 'מסמך הזיכוי במורנינג',
  cancel: 'ביטול ההזמנה והשבתת הצ׳יפים',
};

/** What the confirmation is built from (GET /api/chip-orders/[id]/cancel). */
export interface ReceptionCancelPreviewView {
  order_id: string;
  order_number: number;
  /** 'web' — "ביטול וזיכוי" of a web order (27/11/2026); 'reception' — of a reception order. */
  source: 'web' | 'reception';
  status: string;
  is_test: boolean;
  amount: number;
  payment_method: string | null;
  card: { last4: string | null; env: 'sandbox' | 'production' | null } | null;
  /** Where Morning sends the credit document (null = no email on the order). */
  email: string | null;
  invoice_number: string | null;
  has_invoice: boolean;
  /** The ACTIVE chips of the order the cancellation disables. */
  chips: string[];
  /** null = never started. */
  requested_at: string | null;
  requested_by_name: string | null;
  reason: string | null;
  failed_step: ReceptionCancelStep | null;
  error: string | null;
  refunded: boolean;
  refund_via: string | null;
  refund_note: string | null;
  credit_numbers: string[];
  refund_unanswered: boolean;
  /** PayPlus showed the charge cancelled / refunded after a callback. */
  payplus_reversal: 'cancelled' | 'refunded' | 'partial' | null;
  cancellable: boolean;
}

/** Step 1 of the confirmation: how the money goes back. */
export function receptionCancelMoneyText(p: Pick<ReceptionCancelPreviewView, 'amount' | 'payment_method' | 'card'>): string {
  const sum = formatIlsAfter(p.amount);
  if (p.card) {
    const card = p.card.last4 ? ` ····${p.card.last4}` : '';
    const env = p.card.env === 'sandbox' ? ' (סביבת הבדיקות — ללא כסף אמיתי)' : '';
    return `זיכוי של ${sum} לכרטיס${card} דרך PayPlus${env}. אם העסקה כבר בוטלה או זוכתה בממשק PayPlus — לא יישלח זיכוי נוסף, והדבר יירשם בהזמנה.`;
  }
  if (p.payment_method === 'cash') return `את ${sum} מחזירים ידנית במזומן — המערכת לא מחזירה כסף.`;
  if (p.payment_method === 'bank_transfer') return `את ${sum} מחזירים ידנית בהעברה בנקאית — המערכת לא מחזירה כסף.`;
  return 'את הכסף — אם שולם — מחזירים ידנית, מחוץ למערכת.';
}

/** The short state of a stopped "ביטול וזיכוי" on a line or a row. */
export function receptionCancelStoppedText(step: ReceptionCancelStep): string {
  return `הביטול נעצר: ${RECEPTION_CANCEL_STEP_LABEL[step]}`;
}

// "ביטול וזיכוי" of a reception order (27/11/2026) — the words, shared by the
// confirmation (src/components/chips/ReceptionCancelDialog.tsx), the three
// places that open it, and the tests. No I/O.

import { formatIlsAfter } from './model';

export const RECEPTION_CANCEL_LABEL = 'ביטול וזיכוי';

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

import { priceLine } from './model';

// Issuing a chip at the reception (25/11/2026) — the pure, client-safe half:
// the payment methods of "הנפק צ׳יפ" (the issue window opened with no order),
// the amount of a save, the orderer details, and what a block shows again
// about the save its chips came from.
//
// The ways a save of NEW chips is settled (26/11/2026):
//   · card           — admin / super admin only: PayPlus hosted fields in the
//                      window (the same server rules as the public page). The
//                      card is charged FIRST, for the chips × price the server
//                      computed — a reception order waits for it — and the save
//                      then issues the chips onto that paid order. Real charges
//                      only while live charging is armed; a sandbox TEST mode
//                      makes a test order instead;
//   · cash           — cash; and
//   · bank_transfer  — a bank transfer: the manager confirms the amount was
//                      received. A chip order is created (source 'reception'),
//                      already paid and collected. (Until 26/11/2026 both were
//                      one option, stored 'cash_transfer' — still shown as it was.)
//   · none           — no charge (a guest, staff, a replacement): no order.
// The amount is always computed on the server from the price in /settings;
// the window sends the amount it showed, and a save whose amount moved in
// between is refused instead of recording a sum nobody confirmed.

export type ReceptionPaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'none';

/** The methods a save may name. 'card' needs the paid card order of the window. */
export const RECEPTION_PAYMENT_METHODS: readonly ReceptionPaymentMethod[] = ['cash', 'bank_transfer', 'card', 'none'];

/** Methods that are a received SUM the manager confirms by choosing them. */
export const RECEPTION_CONFIRMED_METHODS: readonly ReceptionPaymentMethod[] = ['cash', 'bank_transfer'];

export const RECEPTION_PAYMENT_LABEL: Record<ReceptionPaymentMethod, string> = {
  card: 'אשראי',
  cash: 'מזומן',
  bank_transfer: 'העברה בנקאית',
  none: 'ללא חיוב',
};

/** How a STORED reception order was paid, for display — including the value
 *  of the orders recorded before the split (26/11/2026). */
export const STORED_PAYMENT_LABEL: Record<string, string> = {
  cash: 'מזומן',
  bank_transfer: 'העברה בנקאית',
  card: 'אשראי',
  cash_transfer: 'מזומן או העברה',
};

/** Under the "אשראי" option while card payment at the reception is not armed. */
export const RECEPTION_CARD_PENDING_TEXT = 'יופעל לאחר חיבור הסליקה';

/** The tag of a reception order — the Orders tab and the order's window. */
export const CHIP_ORDER_RECEPTION_LABEL = 'קבלה';

/** The tag of a reception order that was made for EXTRA chips of a web order
 *  — chips added in that order's window beyond the quantity paid online. */
export const CHIP_ORDER_EXTRA_LABEL = 'צ׳יפים נוספים';

/** The storage ceiling of one apartment line of an order (the CHECK of
 *  chip_order_items / chip_order_holders) — what one PAID save may issue. */
export const RECEPTION_MAX_PAID_CHIPS = 50;

/** New chips × the price per chip, agorot-safe — the same arithmetic the
 *  public page and the order's price line use. */
export function receptionAmount(newChips: number, unitPrice: number): number {
  return priceLine(newChips, { unitPrice }).lineTotal;
}

/** Two sums are the same sum (compared in agorot). */
export function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Who ordered — every field optional on the manager's side. */
export interface ReceptionOrderer {
  name: string | null;
  phone: string | null;
  email: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
}

export const EMPTY_RECEPTION_ORDERER: ReceptionOrderer = {
  name: null, phone: null, email: null, street: null, city: null, zip: null,
};

/** The address in one line, as the order's `address` column holds it:
 *  "רחוב ומספר, עיר מיקוד" — with whatever parts there are. Null when none. */
export function composeReceptionAddress(o: Pick<ReceptionOrderer, 'street' | 'city' | 'zip'>): string | null {
  const town = [o.city, o.zip].map((v) => v?.trim()).filter(Boolean).join(' ');
  const line = [o.street?.trim(), town].filter(Boolean).join(', ');
  return line || null;
}

/** What the window loads besides the apartment's chips. */
export interface ReceptionContext {
  /** ₪ per chip, from /settings — the amount of a save is chips × this. */
  unit_price: number;
  /** "אשראי" is drawn — admin and super admin only. */
  card_option: boolean;
  /** "אשראי" charges for real (live charging is armed). */
  card_live: boolean;
  /** "אשראי" can be tried in the PayPlus sandbox (a test order; the sandbox is configured). */
  card_test: boolean;
  /** The viewer may open a lease ("צפייה בחוזה") — the rule of every lease in
   *  the bucket: chips_orders_manage:view. Without it a block says the lease
   *  is attached, with no link. */
  lease_view: boolean;
  /** The reception saves this apartment's chips came from. */
  records: ReceptionRecordView[];
}

/** The reception saves a set of chips came from — what a holder block of the
 *  issue window, and the holder's own panel, show again under the chips. */
export function receptionRecordsOf(
  chips: { reception_record_id: string | null; order_item_id: string | null }[],
  records: ReceptionRecordView[],
): ReceptionRecordView[] {
  const refs = new Set(chips.flatMap((c) => [c.reception_record_id, c.order_item_id]).filter(Boolean));
  return records.filter((r) => refs.has(r.ref));
}

/** One earlier save of the reception window, as a holder block shows it again:
 *  a no-charge record, or a reception order. */
export interface ReceptionRecordView {
  kind: 'record' | 'order';
  /** What a chip points at: chips.reception_record_id for a record,
   *  chips.order_item_id for an order. */
  ref: string;
  /** A reception order's number. */
  order_number: number | null;
  created_at: string;
  orderer_name: string | null;
  orderer_phone: string | null;
  orderer_email: string | null;
  address: string | null;
  chips_count: number;
  /** What was paid (an order) — 0 for a no-charge record. */
  amount: number;
  /** Who issued / recorded the payment. */
  by_name: string | null;
  /** A reception order that was cancelled afterwards ("בטל הזמנת קבלה"): its
   *  chips were disabled, and the payment no longer stands. */
  cancelled: boolean;
  /** How a reception order was paid ('cash' | 'bank_transfer' | 'card', or
   *  'cash_transfer' before 26/11/2026 — STORED_PAYMENT_LABEL). Null on a
   *  no-charge record. */
  payment_method: string | null;
  /** A reception order's id ("ביטול וזיכוי" acts on it). Null on a record. */
  order_id: string | null;
  /** "ביטול וזיכוי" was started and stopped at this step (27/11/2026), with
   *  its words — the line says so and offers to go on. Null otherwise. */
  cancel_failed_step: 'refund' | 'credit' | 'cancel' | null;
  cancel_error: string | null;
}

// ── The window's own forms ─────────────────────────────────────────────────

/** The orderer details as the window holds them while they are typed. */
export interface OrdererFields {
  name: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  zip: string;
}

export const EMPTY_ORDERER_FIELDS: OrdererFields = { name: '', phone: '', email: '', street: '', city: '', zip: '' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A plain email check for an optional field (the server decides). */
export function looksLikeEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

/** What is wrong with the orderer details as typed — field → message. Every
 *  field is optional: only a value that IS there is checked. `phoneProblem`
 *  is the app's phone rule (validatePhone), handed in so this module stays
 *  free of it. */
export function ordererProblems(
  o: OrdererFields,
  phoneProblem: (phone: string) => string | null,
): Partial<Record<keyof OrdererFields, string>> {
  const out: Partial<Record<keyof OrdererFields, string>> = {};
  // The name has no rule of its own: it follows the first chip holder, and a
  // guest may be known by one letter. (An ORDER needs two letters — the save
  // says so when a payment is recorded under a shorter name.)
  if (o.phone.trim()) {
    const p = phoneProblem(o.phone);
    if (p) out.phone = p;
  }
  if (o.email.trim() && !looksLikeEmail(o.email)) out.email = 'כתובת מייל לא תקינה';
  const street = o.street.trim();
  if (street && street.length < 2) out.street = 'הכתובת קצרה מדי';
  const city = o.city.trim();
  if (city && city.length < 2) out.city = 'שם העיר קצר מדי';
  if (o.zip.trim() && !/^\d{7}$/.test(o.zip.trim())) out.zip = 'מיקוד — 7 ספרות';
  return out;
}

/** The EXTRA chips of a save of a web order's window: new numbers beyond what
 *  an apartment line paid for online. A line that ordered `ordered` chips and
 *  holds `linked` active ones still has room for `ordered - linked`; every new
 *  number past that room is extra. Summed over the lines. The server counts
 *  the same way (saveChipOrderWindow) — this is what the window shows. */
export function extraChipsOf(lines: { ordered: number; linked: number; added: number }[]): number {
  return lines.reduce((sum, l) => sum + Math.max(0, l.added - Math.max(0, l.ordered - l.linked)), 0);
}

/** "מזומן" / "העברה בנקאית" are the confirmation of a SUM — the one that was
 *  on the screen when it was chosen — and "אשראי" is a payment OF a sum. Once
 *  the sum is another one (a chip was added or removed, the price moved) the
 *  choice no longer stands until it is made again. "ללא חיוב" confirms no sum
 *  and always stands. */
export function receptionMethodInForce(input: {
  method: ReceptionPaymentMethod | null;
  /** chips × price now; null = the price could not be loaded. */
  amount: number | null;
  /** The sum on the screen when the method was chosen (cash / transfer), or
   *  the sum the card paid (card). */
  confirmedAmount: number | null;
}): ReceptionPaymentMethod | null {
  if (input.method === null || input.method === 'none') return input.method;
  if (input.amount === null || input.confirmedAmount === null) return input.method;
  return sameAmount(input.amount, input.confirmedAmount) ? input.method : null;
}

/** Why a save of NEW chips cannot go yet, as far as the payment goes — the
 *  line under the payment methods. Null = it can (or there is nothing to pay
 *  for: no new chip in this save). */
export function receptionPaymentReason(input: {
  newChips: number;
  method: ReceptionPaymentMethod | null;
  /** chips × price; null = the price could not be loaded. */
  amount: number | null;
  /** The sum that was confirmed (cash / transfer) or paid (card). */
  confirmedAmount?: number | null;
  /** What is being paid for: the new chips of a reception save (default), or
   *  the EXTRA chips of a web order's window — beyond what was paid online. */
  what?: 'new' | 'extra';
}): string | null {
  if (input.newChips === 0) return null;
  if (input.method === null) {
    return input.what === 'extra'
      ? 'יש לבחור אמצעי תשלום לצ׳יפים שנוספו מעבר לכמות ששולמה'
      : 'יש לבחור אמצעי תשלום כדי להנפיק את הצ׳יפים החדשים';
  }
  if (input.method === 'none') return null;
  if (input.method === 'card' && (input.confirmedAmount ?? null) === null) {
    return 'יש להשלים את התשלום באשראי לפני השמירה';
  }
  if (receptionMethodInForce({ method: input.method, amount: input.amount, confirmedAmount: input.confirmedAmount ?? null }) === null) {
    return input.method === 'card'
      ? 'הסכום שנגבה באשראי אינו הסכום לתשלום עכשיו — יש להחזיר את מספר הצ׳יפים, או לבטל את ההזמנה (זיכוי)'
      : 'הסכום לתשלום השתנה — יש לבחור שוב את אמצעי התשלום כדי לאשר את הסכום החדש';
  }
  if (input.amount === null) return 'המחיר לצ׳יפ לא נטען — סגרו את החלון ופתחו אותו שוב';
  if (input.amount <= 0) return 'אין סכום לגבייה — יש לבחור „ללא חיוב”';
  if (input.newChips > RECEPTION_MAX_PAID_CHIPS) return `בתשלום בקבלה אפשר להנפיק עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים בשמירה אחת`;
  return null;
}

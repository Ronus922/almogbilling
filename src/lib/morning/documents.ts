// Morning documents of chip orders — the PURE part (no I/O): which document
// type the building's account issues for a paid sale, and the exact request
// body of each document. Everything that reaches Morning is built here, so the
// tests can read it field by field (docs/chip-orders.md "מסמכי מורנינג").
//
// THE CHOICE (26/11/2026 — to be confirmed with the accountant before the first
// real charge; /settings shows it, read-only):
//   - a VAT-registered business (עוסק מורשה, חברה בע״מ, שותפות — or any type
//     Morning reports as NOT exempt) → 320 "חשבונית מס / קבלה": the payment was
//     received at the time of the sale. The chip price is the FINAL amount the
//     customer pays: every income row is "VAT included in price" (vatType 1).
//   - a VAT-exempt business (עוסק פטור, or any type Morning reports exempt,
//     e.g. a non-profit) → 400 "קבלה", no VAT.
//   - Morning did not say whether the business is exempt → NO document type:
//     nothing is issued until the account answers (the queue waits).
// Credits (a refund, a cancelled reception order), following Morning's help
// center: a 320 is credited by a 330 "חשבונית זיכוי" AND a negative 400 "קבלה",
// both linked to the original with linkType "cancel"; a 400 by a negative 400.

export type MorningDocType = 320 | 400;

export const BUSINESS_TYPE_LABEL: Record<number, string> = {
  1: 'עוסק מורשה',
  2: 'חברה בע״מ',
  3: 'עוסק פטור',
  4: 'עמותה',
  5: 'חברה לתועלת הציבור',
  6: 'שותפות',
};

export const DOC_TYPE_LABEL: Record<number, string> = {
  320: 'חשבונית מס / קבלה',
  330: 'חשבונית זיכוי',
  400: 'קבלה',
};

export interface DocTypeChoice {
  /** null = no document is issued (the reason says why). */
  docType: MorningDocType | null;
  /** The chip price includes VAT (320) — false for a receipt of an exempt business. */
  vatIncluded: boolean;
  reason: string;
}

export function chooseDocumentType(p: { businessType: number | null; exemption: boolean | null; availableTypes: number[] | null }): DocTypeChoice {
  const exempt = p.exemption ?? (p.businessType === 3 ? true : p.businessType === 1 || p.businessType === 2 || p.businessType === 6 ? false : null);
  if (exempt === null) {
    return { docType: null, vatIncluded: false, reason: 'מורנינג לא החזיר אם העסק פטור ממע״מ — לא מופקים מסמכים עד שזה יתברר' };
  }
  const docType: MorningDocType = exempt ? 400 : 320;
  if (p.availableTypes && !p.availableTypes.includes(docType)) {
    return { docType: null, vatIncluded: false, reason: `סוג המסמך ${docType} (${DOC_TYPE_LABEL[docType]}) אינו זמין בחשבון המורנינג` };
  }
  return exempt
    ? { docType: 400, vatIncluded: false, reason: 'העסק פטור ממע״מ — קבלה, בלי מע״מ' }
    : { docType: 320, vatIncluded: true, reason: 'העסק חייב במע״מ — חשבונית מס / קבלה; מחיר הצ׳יפ כולל מע״מ' };
}

/** PaymentGroup of the documentation: 1 מזומן, 3 כרטיס אשראי, 4 העברה בנקאית. */
export const MORNING_PAYMENT_TYPE = { cash: 1, card: 3, bank_transfer: 4 } as const;
export type DocPaymentMethod = keyof typeof MORNING_PAYMENT_TYPE;

export interface DocIncomeLine {
  quantity: number;
  /** The price of ONE chip, as the order froze it (₪, final). */
  unitPrice: number;
}

export interface DocClient {
  name: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
}

export interface DocPayment {
  method: DocPaymentMethod;
  /** YYYY-MM-DD, Israel time — the day the money moved. */
  date: string;
  last4: string | null;
}

/** Money as whole agorot. */
const ag = (n: number) => Math.round(n * 100);

/** "כרטיסי בקרת כניסה — הזמנה 1042 — דירה 12" (two apartments: "דירות 12, 14"). */
export function documentDescription(orderNumber: number, apartments: string[]): string {
  const apts = [...new Set(apartments.filter(Boolean))];
  const where = apts.length === 0 ? '' : apts.length === 1 ? ` — דירה ${apts[0]}` : ` — דירות ${apts.join(', ')}`;
  return `כרטיסי בקרת כניסה — הזמנה ${orderNumber}${where}`;
}

/** The income rows of an order's apartment lines (the price snapshot of each
 *  line: the first `threshold` chips at unit_price, the rest at price_above —
 *  since 21/11/2026 one flat price), merged by price. */
export function incomeLinesOf(items: { chipsCount: number; unitPrice: number; threshold: number; priceAbove: number }[]): DocIncomeLine[] {
  const byPrice = new Map<number, number>();
  for (const it of items) {
    const base = Math.max(0, Math.min(it.chipsCount, it.threshold));
    const above = Math.max(0, it.chipsCount - base);
    if (base > 0) byPrice.set(ag(it.unitPrice), (byPrice.get(ag(it.unitPrice)) ?? 0) + base);
    if (above > 0) byPrice.set(ag(it.priceAbove), (byPrice.get(ag(it.priceAbove)) ?? 0) + above);
  }
  return [...byPrice.entries()].sort((a, b) => a[0] - b[0]).map(([price, quantity]) => ({ quantity, unitPrice: price / 100 }));
}

export class DocumentBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentBuildError';
  }
}

function clientOf(c: DocClient): Record<string, unknown> {
  return {
    name: c.name,
    ...(c.email ? { emails: [c.email] } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.street ? { address: c.street } : {}),
    ...(c.city ? { city: c.city } : {}),
    ...(c.zip ? { zip: c.zip } : {}),
    country: 'IL',
    add: false,
  };
}

function incomeRows(lines: DocIncomeLine[], choice: { vatIncluded: boolean }, sign: 1 | -1 = 1): Record<string, unknown>[] {
  return lines.map((l) => ({
    description: 'כרטיס בקרת כניסה',
    quantity: l.quantity,
    price: sign * l.unitPrice,
    currency: 'ILS',
    // 1 = VAT included in the price (the chip price is final); 0 = the
    // business default (no VAT for an exempt business).
    vatType: choice.vatIncluded ? 1 : 0,
  }));
}

function paymentRow(p: DocPayment, amount: number): Record<string, unknown> {
  return {
    type: MORNING_PAYMENT_TYPE[p.method],
    date: p.date,
    price: amount,
    currency: 'ILS',
    ...(p.method === 'card'
      ? { ...(p.last4 ? { cardNum: p.last4 } : {}), cardType: 0, dealType: 1, numPayments: 1 }
      : {}),
  };
}

function assertTotal(lines: DocIncomeLine[], amount: number): void {
  const sum = lines.reduce((s, l) => s + l.quantity * ag(l.unitPrice), 0);
  if (lines.length === 0 || sum !== ag(amount)) {
    throw new DocumentBuildError(`סכום השורות (${sum / 100}) אינו הסכום ששולם (${amount})`);
  }
}

export interface InvoiceInput {
  docType: MorningDocType;
  vatIncluded: boolean;
  orderNumber: number;
  apartments: string[];
  client: DocClient;
  lines: DocIncomeLine[];
  /** What was paid — the document's total must be exactly this. */
  amount: number;
  payment: DocPayment;
  /** Our unique reference, printed in the remarks (crash recovery). */
  ref: string;
  /** YYYY-MM-DD, Israel time — today (the document date). */
  date: string;
}

/** The body of the document for a payment (320 or 400). Throws
 *  DocumentBuildError when the rows do not add up to the amount paid. */
export function buildInvoiceBody(i: InvoiceInput): Record<string, unknown> {
  assertTotal(i.lines, i.amount);
  return {
    type: i.docType,
    lang: 'he',
    currency: 'ILS',
    vatType: 0,
    date: i.date,
    description: documentDescription(i.orderNumber, i.apartments),
    remarks: `מזהה: ${i.ref}`,
    client: clientOf(i.client),
    income: incomeRows(i.lines, i),
    payment: [paymentRow(i.payment, i.amount)],
    signed: true,
    attachment: true,
    rounding: false,
  };
}

export interface CreditInput {
  /** The type of the document being credited (320 or 400). */
  originalType: MorningDocType;
  originalId: string;
  vatIncluded: boolean;
  orderNumber: number;
  apartments: string[];
  client: DocClient;
  lines: DocIncomeLine[];
  /** The amount returned (≤ the amount paid). */
  amount: number;
  /** How the money went back (the original payment's method). */
  payment: DocPayment;
  ref: string;
  date: string;
}

/** The documents that credit a payment, in the order they are issued:
 *  320 → [330 credit invoice, negative 400]; 400 → [negative 400]. A partial
 *  credit carries only the amount returned (one income row of that amount). */
export function buildCreditBodies(c: CreditInput): Record<string, unknown>[] {
  const full = c.lines.reduce((s, l) => s + l.quantity * ag(l.unitPrice), 0) === ag(c.amount);
  const lines: DocIncomeLine[] = full ? c.lines : [{ quantity: 1, unitPrice: c.amount }];
  assertTotal(lines, c.amount);
  const common = {
    lang: 'he',
    currency: 'ILS',
    date: c.date,
    description: `זיכוי — ${documentDescription(c.orderNumber, c.apartments)}`,
    remarks: `מזהה: ${c.ref}`,
    client: clientOf(c.client),
    linkedDocumentIds: [c.originalId],
    linkType: 'cancel',
    signed: true,
    attachment: true,
    rounding: false,
  };
  // The negative receipt records the money going back. After a 330 (a VAT
  // business) the income is credited on the 330, so the receipt carries the
  // payment row only; cancelling an exempt business's receipt (400) credits
  // its income rows on the receipt itself.
  const negativeReceipt = {
    ...common,
    type: 400,
    vatType: 0,
    income: c.originalType === 400 ? incomeRows(lines, { vatIncluded: false }, -1) : [],
    payment: [paymentRow(c.payment, -c.amount)],
  };
  if (c.originalType === 400) return [negativeReceipt];
  return [
    {
      ...common,
      type: 330,
      vatType: 0,
      income: incomeRows(lines, { vatIncluded: c.vatIncluded }),
    },
    negativeReceipt,
  ];
}

/** Today in Israel, YYYY-MM-DD (Morning refuses a future date). */
export function israelDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

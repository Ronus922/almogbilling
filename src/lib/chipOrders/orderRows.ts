import { DELIVERY_NOTE_LABEL, GUARD_NOTE_LABEL, ORDERER_NOTE_LABEL } from './notes';
import { e164ToLocal } from '@/lib/portal/phone';
import { exportDate, exportDateTime, type ListExport } from '@/lib/export/list-export';
import {
  CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStage, chipOrderStageLabel, isChipOrderOverdue,
  type ChipOrderRow,
} from './model';
import { CHIP_ORDER_EXTRA_LABEL, CHIP_ORDER_RECEPTION_LABEL } from './reception';
import { CLOSED_BY_HAND_LABEL, PAYPLUS_REVERSAL_LABEL } from './receptionCancelText';

// The Orders tab of /chips (24/11/2026) — the pure, client-safe half of what
// the tab does with its rows: the search, the tags of a row, what the action
// column of a row offers, how a row was paid and where its invoice stands, and
// the columns of the Excel file, of the print view and of the PDF file.
//
// A ROW IS ONE APARTMENT OF AN ORDER, and everything here keeps that shape:
// the search filters rows, and the three exports hold one line per row on the
// screen. Only the status is wider than a row — it belongs to the whole order
// — so the action column is decided from all the order's rows.

// ── Search ─────────────────────────────────────────────────────────────────

type Searchable = Pick<ChipOrderRow, 'order_number' | 'apartment_number' | 'full_name' | 'people'>;

const fold = (s: string) => s.toLocaleLowerCase('he').trim();

/** The tab's search: by order number, by apartment number and by name — the
 *  orderer's and the names of the people of the row. Like the search of the
 *  chips tab: the text is split into words, every word must be found, each in
 *  any of the fields. A word made of digits also finds the ORDER whose number
 *  starts with it (26/11/2026 — "10" finds order 1042, never 2104), the rule
 *  of the guard's pickup screen; the apartment keeps its own rule. */
export function filterChipOrderRows<T extends Searchable>(rows: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const fields = [r.apartment_number, r.full_name, ...r.people].map(fold);
    const order = String(r.order_number);
    return words.every((w) => fields.some((f) => f.includes(w)) || (/^\d+$/.test(w) && order.startsWith(w)));
  });
}

/** The people of a row that the search found and the row does not show by
 *  itself (a row prints the orderer and the apartment) — so a row that came up
 *  through a renter's name says why it is there. */
export function searchHitPeople(row: Searchable, query: string): string[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const orderer = fold(row.full_name);
  return row.people.filter((p) => fold(p) !== orderer && words.some((w) => fold(p).includes(w)));
}

// ── The tags of a row ("תגיות") ────────────────────────────────────────────

/** What a row is flagged with, in the order the tags are shown: an order made
 *  at the reception ("קבלה", 25/11/2026 — paid there and handed over on the
 *  spot), a test-mode order, a phone nobody proved (a test order made with
 *  "דלג על אימות" — only `phone_verified === false`: NULL is an order from a
 *  form with no code step, 26/11/2026), a message to the orderer that
 *  failed to go out, and — first, in red — a paid order PayPlus shows
 *  cancelled or refunded that waits for "ביטול וזיכוי" (27/11/2026). */
export type ChipOrderTag = 'payplus_reversed' | 'closed_by_hand' | 'reception' | 'extra' | 'test' | 'phone_unverified' | 'notify_failed';

export const CHIP_ORDER_TAG_LABEL: Record<ChipOrderTag, string> = {
  payplus_reversed: PAYPLUS_REVERSAL_LABEL,
  // "סגירה ידנית" of a stuck "ביטול וזיכוי" (27/11/2026) — a permanent mark.
  closed_by_hand: CLOSED_BY_HAND_LABEL,
  reception: CHIP_ORDER_RECEPTION_LABEL,
  // A reception order made for extra chips of a web order (25/11/2026).
  extra: CHIP_ORDER_EXTRA_LABEL,
  test: CHIP_ORDER_TEST_LABEL,
  phone_unverified: CHIP_ORDER_PHONE_UNVERIFIED_LABEL,
  notify_failed: 'הודעה נכשלה',
};

type Tagged = Pick<ChipOrderRow, 'is_test' | 'phone_verified' | 'has_failed_notification'>
  & Partial<Pick<ChipOrderRow, 'source' | 'extra_of_order_number' | 'payplus_reversal_kind' | 'closed_by_hand_step'>>;

export function chipOrderRowTags(row: Tagged): ChipOrderTag[] {
  const tags: ChipOrderTag[] = [];
  if (row.payplus_reversal_kind) tags.push('payplus_reversed');
  if (row.closed_by_hand_step) tags.push('closed_by_hand');
  if (row.source === 'reception') tags.push('reception');
  if (row.extra_of_order_number != null) tags.push('extra');
  if (row.is_test) tags.push('test');
  if (row.phone_verified === false) tags.push('phone_unverified');
  if (row.has_failed_notification) tags.push('notify_failed');
  return tags;
}

// ── The action column of a row ─────────────────────────────────────────────

export interface ChipOrderSummary {
  /** Ordered chips not issued yet, over ALL the apartments of the order. */
  missing: number;
  /** The order's apartments, in the order of the rows. */
  apartments: string[];
}

/** One summary per order, from ALL the rows of the tab — never from a
 *  filtered list: an apartment the search hid still holds the order back. */
export function summarizeChipOrders(
  rows: Pick<ChipOrderRow, 'order_id' | 'apartment_number' | 'chips_count' | 'chips_linked'>[],
): Map<string, ChipOrderSummary> {
  const out = new Map<string, ChipOrderSummary>();
  for (const r of rows) {
    const s = out.get(r.order_id) ?? { missing: 0, apartments: [] };
    s.missing += Math.max(0, r.chips_count - r.chips_linked);
    s.apartments.push(r.apartment_number);
    out.set(r.order_id, s);
  }
  return out;
}

/** "חסר צ׳יפ אחד" / "חסרים 3 צ׳יפים" — why "מוכן לאיסוף" waits. */
export function missingChipsText(missing: number): string {
  return missing === 1 ? 'חסר צ׳יפ אחד' : `חסרים ${missing} צ׳יפים`;
}

/** What the action column of a row holds — the order's NEXT step, without
 *  opening the window:
 *    · waiting   — chips are still missing: nothing to press. A plain label
 *                  ("בהמתנה") with what is missing under it. A dimmed
 *                  "מוכן לאיסוף" read as if the order were ready (25/11/2026);
 *    · ready     — every chip of the whole order is issued and saved (the
 *                  server's own rule): the button "מוכן לאיסוף";
 *    · collected — the order is ready: the button "נאסף";
 *    · done      — the order is collected already (a reception order: paid
 *                  and handed over in one go): nothing left to do. A plain
 *                  label, "נאסף" — not a button;
 *    · cancelled — a reception order that was cancelled (it stays in the tab):
 *                  a plain label, "בוטל". */
export type ChipOrderRowAction =
  | { kind: 'waiting'; missing: string }
  | { kind: 'ready' }
  | { kind: 'collected' }
  | { kind: 'done' }
  | { kind: 'cancelled' };

/** The label of a row that waits for its chips. */
export const CHIP_ORDER_WAITING_LABEL = 'בהמתנה';

export function chipOrderRowAction(
  row: Pick<ChipOrderRow, 'order_id' | 'status'> & Partial<Pick<ChipOrderRow, 'source' | 'refund_in_flight' | 'payplus_reversal_kind'>>,
  summary: ChipOrderSummary | undefined,
): ChipOrderRowAction | null {
  // A refund waiting for PayPlus's answer, or a charge PayPlus shows cancelled
  // (27/11/2026): nothing moves the order on.
  if ((row.refund_in_flight || row.payplus_reversal_kind) && (row.status === 'paid' || row.status === 'approved' || row.status === 'ready')) return null;
  if (row.status === 'ready') return { kind: 'collected' };
  if (row.status === 'collected') return { kind: 'done' };
  // A rejected reception order is a cancelled one. A rejected WEB order stays
  // in the tab only when it was refunded (26/11/2026): readable, with its
  // "זוכה" in the payment column, and nothing to press.
  if (row.status === 'rejected') return row.source === 'reception' ? { kind: 'cancelled' } : null;
  if (row.status !== 'paid' && row.status !== 'approved') return null;
  const missing = summary?.missing ?? 0;
  if (missing === 0) return { kind: 'ready' };
  const several = (summary?.apartments.length ?? 1) > 1;
  return { kind: 'waiting', missing: several ? `${missingChipsText(missing)} בהזמנה` : missingChipsText(missing) };
}

// ── How a row was paid ("תשלום", 26/11/2026) ──────────────────────────────

/** One short word for how an order was paid — the "תשלום" column, the phone
 *  card and the three exports. "ללא חיוב" is never an order (a no-charge save
 *  makes a reception RECORD, not an order), but the label stays available. */
export type ChipOrderPaymentKind =
  | 'refunded' | 'partial' | 'test' | 'card' | 'card_test' | 'cash' | 'bank_transfer' | 'cash_transfer' | 'none';

export const CHIP_ORDER_PAYMENT_LABEL: Record<ChipOrderPaymentKind, string> = {
  refunded: 'זוכה',
  partial: 'זוכה חלקית',
  test: 'בדיקה, ללא חיוב',
  card: 'אשראי',
  card_test: 'אשראי · בדיקה',
  cash: 'מזומן',
  bank_transfer: 'העברה',
  // A reception order recorded before the two were split (26/11/2026).
  cash_transfer: 'מזומן או העברה',
  none: 'ללא חיוב',
};

type Paid = Pick<ChipOrderRow, 'is_test'>
  & Partial<Pick<ChipOrderRow, 'payment_method' | 'card_status' | 'card_env' | 'refund_status'>>;

/** How a row was paid, first rule that holds: a refund (full / part); a test
 *  order no card paid; a card the processor confirmed (the sandbox = a test
 *  card); the method a reception order recorded. Null = nothing to say (a web
 *  order of the former processor, or a row from an older build) — "—". */
export function chipOrderRowPayment(row: Paid): ChipOrderPaymentKind | null {
  if (row.refund_status === 'refunded') return 'refunded';
  if (row.refund_status === 'partial') return 'partial';
  const card = row.card_status === 'paid';
  if (row.is_test && !card) return 'test';
  if (card) return row.card_env === 'sandbox' ? 'card_test' : 'card';
  switch (row.payment_method) {
    case 'cash': return 'cash';
    case 'bank_transfer': return 'bank_transfer';
    case 'cash_transfer': return 'cash_transfer';
    default: return null;
  }
}

/** The payment of a row in words — "—" when there is nothing to say. */
export function chipOrderRowPaymentText(row: Paid): string {
  const kind = chipOrderRowPayment(row);
  return kind ? CHIP_ORDER_PAYMENT_LABEL[kind] : '—';
}

// ── Where a Morning document stands ("חשבונית", 26/11/2026) ────────────────

export const CHIP_ORDER_DOC_TEXT = {
  /** Queued, and Morning has no key yet — it is issued once Morning is connected. */
  waitingMorning: 'ממתינה לחיבור מורנינג',
  /** Queued (or being issued) with Morning connected. */
  issuing: 'בהפקה',
  failed: 'לא הופקה',
} as const;

export type ChipOrderDocState =
  | { kind: 'issued'; number: string | null; url: string | null }
  | { kind: 'waiting'; text: string }
  | { kind: 'failed'; text: string }
  | { kind: 'none' };

/** Only an https link is ever drawn: the address comes from Morning, and an
 *  `href` must never carry anything a browser would run. */
export function safeDocumentUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

/** One Morning document as the tab and the order's window show it: issued →
 *  its number (and its link); still queued → "בהפקה", or "ממתינה לחיבור
 *  מורנינג" while Morning has no key (`connected`); failed → "לא הופקה". */
export function chipOrderDocState(
  doc: { status: 'pending' | 'issuing' | 'issued' | 'failed'; number: string | null; url: string | null } | null | undefined,
  connected: boolean,
): ChipOrderDocState {
  if (!doc) return { kind: 'none' };
  if (doc.status === 'issued') return { kind: 'issued', number: doc.number?.trim() || null, url: safeDocumentUrl(doc.url) };
  if (doc.status === 'failed') return { kind: 'failed', text: CHIP_ORDER_DOC_TEXT.failed };
  return { kind: 'waiting', text: connected ? CHIP_ORDER_DOC_TEXT.issuing : CHIP_ORDER_DOC_TEXT.waitingMorning };
}

/** The invoice of a row — its order's first payment document. A test order
 *  never has one. */
export function chipOrderRowDocument(
  row: Pick<ChipOrderRow, 'is_test'> & Partial<Pick<ChipOrderRow, 'invoice_doc'>>,
  connected: boolean,
): ChipOrderDocState {
  return row.is_test ? { kind: 'none' } : chipOrderDocState(row.invoice_doc, connected);
}

// ── Excel, print and PDF: one column model ─────────────────────────────────

/** The people of a row. The server already names whoever ordered on a line
 *  that has no holder line of its own; the fallback here covers rows that
 *  came without `people` at all (a tab left open across a rollback). */
export function chipOrderRowPeople(row: Pick<ChipOrderRow, 'people' | 'full_name'>): string[] {
  return row.people.length > 0 ? row.people : [row.full_name];
}

/** The row's stage as the tab shows it, in words: the pill, and "באיחור". */
export function chipOrderRowStatusText(
  row: Pick<ChipOrderRow, 'status' | 'chips_linked' | 'chips_count' | 'due_at'> & Partial<Pick<ChipOrderRow, 'source'>>,
  now: Date = new Date(),
): string {
  const stage = chipOrderStageLabel(chipOrderStage(row.status, row.chips_linked, row.chips_count, row.source), row.chips_linked, row.chips_count);
  return isChipOrderOverdue(row, now) ? `${stage} · באיחור` : stage;
}

/** The tags of a row in words, as the three exports write them. */
export function chipOrderRowTagsText(row: Tagged): string {
  return chipOrderRowTags(row).map((t) => CHIP_ORDER_TAG_LABEL[t]).join(', ');
}

/** The orderer's phone as the tab shows it — an Israeli mobile in its local
 *  form. A reception order may have none. */
export function chipOrderRowPhone(row: Pick<ChipOrderRow, 'phone_e164'>): string {
  return row.phone_e164 ? e164ToLocal(row.phone_e164) : '';
}

/** Rows that still wait for someone — what the badge on the tab counts. A
 *  test order is never counted, and neither is an order that is closed
 *  already (a reception order stays in the tab — collected, or cancelled —
 *  but nothing is left to do). */
export function countOpenChipOrderRows(rows: Pick<ChipOrderRow, 'is_test' | 'status'>[]): number {
  return rows.filter((r) => !r.is_test && r.status !== 'collected' && r.status !== 'rejected').length;
}

/** Who may be named as the person who collected an order — its people over
 *  ALL its apartment rows, each once, in the order of the rows. `key` is what
 *  the server is told (a holder line id, or the orderer). */
export function chipOrderCollectors(
  rows: Pick<ChipOrderRow, 'order_id' | 'apartment_number' | 'people' | 'people_keys'>[],
  orderId: string,
): { key: string; name: string; apartment: string }[] {
  const out: { key: string; name: string; apartment: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.order_id !== orderId) continue;
    // A row that came without the keys (a tab left open across a deploy)
    // offers nobody: naming the collector is optional here.
    const keys = r.people_keys ?? [];
    keys.forEach((key, i) => {
      const name = r.people[i];
      if (!name || seen.has(key)) return;
      seen.add(key);
      out.push({ key, name, apartment: r.apartment_number });
    });
  }
  return out;
}

/** The invoice number of a row, as the three exports write it — the number
 *  of an issued document, else an empty cell. */
export function chipOrderRowDocumentNumber(row: Pick<ChipOrderRow, 'is_test'> & Partial<Pick<ChipOrderRow, 'invoice_doc'>>): string {
  const doc = chipOrderRowDocument(row, true);
  return doc.kind === 'issued' ? doc.number ?? '' : '';
}

/** The Orders tab as a file — its names, and its columns right to left. The
 *  amount is the apartment line's own (the lines of one order add up to what
 *  the order paid), so a column of the file can be summed. The title says
 *  "orders", not "open orders", since 25/11/2026: the tab also lists the
 *  reception orders, which are collected (tagged "קבלה", status "נאסף").
 *  26/11/2026: how the order was paid, and its invoice number, after the sum. */
export const CHIP_ORDERS_EXPORT: ListExport<ChipOrderRow> = {
  title: 'הזמנות צ׳יפים',
  sheet: 'הזמנות צ׳יפים',
  file: 'chip-orders',
  columns: [
    { header: 'מס׳ הזמנה', kind: 'number', width: 12, get: (r) => r.order_number },
    { header: 'תאריך הזמנה', kind: 'ltr', width: 13, get: (r) => exportDate(r.created_at) },
    { header: 'שם המזמין', kind: 'text', width: 24, get: (r) => r.full_name },
    { header: 'טלפון', kind: 'ltr', width: 15, get: (r) => chipOrderRowPhone(r) },
    { header: 'תגיות', kind: 'text', width: 24, get: (r) => chipOrderRowTagsText(r) },
    { header: 'דירה', kind: 'ltr', width: 9, get: (r) => r.apartment_number },
    { header: 'בעלי הצ׳יפ', kind: 'text', width: 34, get: (r) => chipOrderRowPeople(r).join(', ') },
    { header: 'כמות', kind: 'number', width: 8, get: (r) => r.chips_count },
    { header: 'סה״כ (₪)', kind: 'money', width: 11, get: (r) => r.line_total },
    {
      header: 'תשלום', kind: 'text', width: 16,
      get: (r) => {
        const kind = chipOrderRowPayment(r);
        return kind ? CHIP_ORDER_PAYMENT_LABEL[kind] : '';
      },
    },
    { header: 'חשבונית', kind: 'ltr', width: 12, get: (r) => chipOrderRowDocumentNumber(r) },
    { header: 'סטטוס', kind: 'text', width: 22, get: (r, now) => chipOrderRowStatusText(r, now) },
    { header: 'יעד להכנה', kind: 'ltr', width: 18, get: (r) => (r.due_at ? exportDateTime(r.due_at) : '') },
    { header: 'הזמנת בדיקה', kind: 'text', width: 13, get: (r) => (r.is_test ? 'כן' : 'לא') },
    // The three notes (27/11/2026), each its own column.
    { header: ORDERER_NOTE_LABEL, kind: 'text', width: 30, get: (r) => r.orderer_note ?? '' },
    { header: GUARD_NOTE_LABEL, kind: 'text', width: 30, get: (r) => r.guard_note ?? '' },
    { header: DELIVERY_NOTE_LABEL, kind: 'text', width: 30, get: (r) => r.delivery_note ?? '' },
  ],
};

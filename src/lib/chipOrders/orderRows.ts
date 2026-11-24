import { e164ToLocal } from '@/lib/portal/phone';
import { exportDate, exportDateTime, type ListExport } from '@/lib/export/list-export';
import {
  CHIP_ORDER_PHONE_UNVERIFIED_LABEL, CHIP_ORDER_TEST_LABEL, chipOrderStage, chipOrderStageLabel, isChipOrderOverdue,
  type ChipOrderRow,
} from './model';

// The Orders tab of /chips (24/11/2026) — the pure, client-safe half of what
// the tab does with its rows: the search, the tags of a row, what the action
// column of a row offers, and the columns of the Excel file, of the print view
// and of the PDF file.
//
// A ROW IS ONE APARTMENT OF AN ORDER, and everything here keeps that shape:
// the search filters rows, and the three exports hold one line per row on the
// screen. Only the status is wider than a row — it belongs to the whole order
// — so the action column is decided from all the order's rows.

// ── Search ─────────────────────────────────────────────────────────────────

type Searchable = Pick<ChipOrderRow, 'apartment_number' | 'full_name' | 'people'>;

const fold = (s: string) => s.toLocaleLowerCase('he').trim();

/** The tab's search: by apartment number and by name — the orderer's and the
 *  names of the people of the row. Like the search of the chips tab: the text
 *  is split into words, every word must be found, each in any of the fields. */
export function filterChipOrderRows<T extends Searchable>(rows: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const fields = [r.apartment_number, r.full_name, ...r.people].map(fold);
    return words.every((w) => fields.some((f) => f.includes(w)));
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

/** What a row is flagged with, in the order the tags are shown: a test-mode
 *  order, a phone nobody proved (a test order made with "דלג על אימות"), and a
 *  message to the orderer that failed to go out. */
export type ChipOrderTag = 'test' | 'phone_unverified' | 'notify_failed';

export const CHIP_ORDER_TAG_LABEL: Record<ChipOrderTag, string> = {
  test: CHIP_ORDER_TEST_LABEL,
  phone_unverified: CHIP_ORDER_PHONE_UNVERIFIED_LABEL,
  notify_failed: 'הודעה נכשלה',
};

export function chipOrderRowTags(
  row: Pick<ChipOrderRow, 'is_test' | 'phone_verified' | 'has_failed_notification'>,
): ChipOrderTag[] {
  const tags: ChipOrderTag[] = [];
  if (row.is_test) tags.push('test');
  if (!row.phone_verified) tags.push('phone_unverified');
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
 *    · collected — the order is ready: the button "נאסף". */
export type ChipOrderRowAction =
  | { kind: 'waiting'; missing: string }
  | { kind: 'ready' }
  | { kind: 'collected' };

/** The label of a row that waits for its chips. */
export const CHIP_ORDER_WAITING_LABEL = 'בהמתנה';

export function chipOrderRowAction(
  row: Pick<ChipOrderRow, 'order_id' | 'status'>,
  summary: ChipOrderSummary | undefined,
): ChipOrderRowAction | null {
  if (row.status === 'ready') return { kind: 'collected' };
  if (row.status !== 'paid' && row.status !== 'approved') return null;
  const missing = summary?.missing ?? 0;
  if (missing === 0) return { kind: 'ready' };
  const several = (summary?.apartments.length ?? 1) > 1;
  return { kind: 'waiting', missing: several ? `${missingChipsText(missing)} בהזמנה` : missingChipsText(missing) };
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
  row: Pick<ChipOrderRow, 'status' | 'chips_linked' | 'chips_count' | 'due_at'>,
  now: Date = new Date(),
): string {
  const stage = chipOrderStageLabel(chipOrderStage(row.status, row.chips_linked, row.chips_count), row.chips_linked, row.chips_count);
  return isChipOrderOverdue(row, now) ? `${stage} · באיחור` : stage;
}

/** The tags of a row in words, as the three exports write them. */
export function chipOrderRowTagsText(row: Pick<ChipOrderRow, 'is_test' | 'phone_verified' | 'has_failed_notification'>): string {
  return chipOrderRowTags(row).map((t) => CHIP_ORDER_TAG_LABEL[t]).join(', ');
}

/** The Orders tab as a file — its names, and its columns right to left. The
 *  amount is the apartment line's own (the lines of one order add up to what
 *  the order paid), so a column of the file can be summed. */
export const CHIP_ORDERS_EXPORT: ListExport<ChipOrderRow> = {
  title: 'הזמנות צ׳יפים פתוחות',
  sheet: 'הזמנות צ׳יפים',
  file: 'chip-orders',
  columns: [
    { header: 'מס׳ הזמנה', kind: 'number', width: 12, get: (r) => r.order_number },
    { header: 'תאריך הזמנה', kind: 'ltr', width: 13, get: (r) => exportDate(r.created_at) },
    { header: 'שם המזמין', kind: 'text', width: 24, get: (r) => r.full_name },
    { header: 'טלפון', kind: 'ltr', width: 15, get: (r) => e164ToLocal(r.phone_e164) },
    { header: 'תגיות', kind: 'text', width: 24, get: (r) => chipOrderRowTagsText(r) },
    { header: 'דירה', kind: 'ltr', width: 9, get: (r) => r.apartment_number },
    { header: 'בעלי הצ׳יפ', kind: 'text', width: 34, get: (r) => chipOrderRowPeople(r).join(', ') },
    { header: 'כמות', kind: 'number', width: 8, get: (r) => r.chips_count },
    { header: 'סה״כ (₪)', kind: 'money', width: 11, get: (r) => r.line_total },
    { header: 'סטטוס', kind: 'text', width: 22, get: (r, now) => chipOrderRowStatusText(r, now) },
    { header: 'יעד להכנה', kind: 'ltr', width: 18, get: (r) => (r.due_at ? exportDateTime(r.due_at) : '') },
    { header: 'הזמנת בדיקה', kind: 'text', width: 13, get: (r) => (r.is_test ? 'כן' : 'לא') },
  ],
};

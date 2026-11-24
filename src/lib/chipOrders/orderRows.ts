import { e164ToLocal } from '@/lib/portal/phone';
import { chipOrderStage, chipOrderStageLabel, isChipOrderOverdue, type ChipOrderRow } from './model';

// The Orders tab of /chips (24/11/2026) — the pure, client-safe half of what
// the tab does with its rows: the search, what the quick status button of a
// row may do, and the columns of the Excel file and of the print view.
//
// A ROW IS ONE APARTMENT OF AN ORDER, and everything here keeps that shape:
// the search filters rows, the Excel file and the print view hold one line per
// row on the screen. Only the status is wider than a row — it belongs to the
// whole order — so the quick button is decided from all the order's rows.

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

// ── The quick status button of a row ───────────────────────────────────────

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

/** The one status step a row offers without opening the window — the order's
 *  NEXT step: "מוכן לאיסוף" while it is being assigned (pressable only once
 *  every chip of the whole order is issued and saved — the server's own rule;
 *  otherwise off, with the reason), "נאסף" once it is ready. */
export type ChipOrderRowAction =
  | { kind: 'ready'; enabled: boolean; reason: string | null }
  | { kind: 'collected' };

export function chipOrderRowAction(
  row: Pick<ChipOrderRow, 'order_id' | 'status'>,
  summary: ChipOrderSummary | undefined,
): ChipOrderRowAction | null {
  if (row.status === 'ready') return { kind: 'collected' };
  if (row.status !== 'paid' && row.status !== 'approved') return null;
  const missing = summary?.missing ?? 0;
  if (missing === 0) return { kind: 'ready', enabled: true, reason: null };
  const several = (summary?.apartments.length ?? 1) > 1;
  return { kind: 'ready', enabled: false, reason: several ? `${missingChipsText(missing)} בהזמנה` : missingChipsText(missing) };
}

// ── Excel + print: one column model ────────────────────────────────────────

const IL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function ilParts(iso: string): Record<string, string> {
  return Object.fromEntries(IL.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}

/** dd/mm/yyyy in Israel time. */
export function formatOrderDate(iso: string): string {
  const p = ilParts(iso);
  return `${p.day}/${p.month}/${p.year}`;
}

/** dd/mm/yyyy hh:mm in Israel time. */
export function formatOrderDateTime(iso: string): string {
  const p = ilParts(iso);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

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

export interface ChipOrderExportColumn {
  header: string;
  /** number / money — numeric cells Excel can sum; ltr — a phone or a date,
   *  kept as text and isolated left-to-right in print. */
  kind: 'text' | 'number' | 'money' | 'ltr';
  /** Excel column width (characters). Print ignores it. */
  width: number;
  get: (row: ChipOrderRow, now: Date) => string | number;
}

/** The columns of the Excel file and of the print view, right to left. The
 *  amount is the apartment line's own (the lines of one order add up to what
 *  the order paid), so a column of the file can be summed. */
export const CHIP_ORDER_EXPORT_COLUMNS: ChipOrderExportColumn[] = [
  { header: 'מס׳ הזמנה', kind: 'number', width: 12, get: (r) => r.order_number },
  { header: 'תאריך הזמנה', kind: 'ltr', width: 13, get: (r) => formatOrderDate(r.created_at) },
  { header: 'שם המזמין', kind: 'text', width: 24, get: (r) => r.full_name },
  { header: 'טלפון', kind: 'ltr', width: 15, get: (r) => e164ToLocal(r.phone_e164) },
  { header: 'דירה', kind: 'ltr', width: 9, get: (r) => r.apartment_number },
  { header: 'בעלי הצ׳יפ', kind: 'text', width: 34, get: (r) => chipOrderRowPeople(r).join(', ') },
  { header: 'כמות', kind: 'number', width: 8, get: (r) => r.chips_count },
  { header: 'סה״כ (₪)', kind: 'money', width: 11, get: (r) => r.line_total },
  { header: 'סטטוס', kind: 'text', width: 22, get: (r, now) => chipOrderRowStatusText(r, now) },
  { header: 'יעד להכנה', kind: 'ltr', width: 18, get: (r) => (r.due_at ? formatOrderDateTime(r.due_at) : '') },
  { header: 'הזמנת בדיקה', kind: 'text', width: 13, get: (r) => (r.is_test ? 'כן' : 'לא') },
];

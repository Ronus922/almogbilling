/**
 * dateUtils — תאריכים כמחרוזות YYYY-MM-DD בלבד, השוואה לקסיקוגרפית.
 * אין Date ב-state ואין toISOString: כל החישובים דרך Date.UTC כדי שאזור זמן ו-DST
 * לא יזיזו תאריך בחצות. `today` מחושב מרכיבי התאריך המקומי.
 */
import { TEXTS } from './texts';

export type DateKey = string;

export const MONTH_NAMES_HE = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
] as const;

/** ימי השבוע, ראשון עד שבת. העמודה הימנית בלוח היא א. */
export const WEEKDAY_LETTERS_HE = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const;

export interface YearMonth { y: number; m: number } // m הוא 0-based כמו ב-Date
export interface YMD extends YearMonth { d: number }

const DAY_MS = 86_400_000;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** key(2026, 9, 4) → '2026-10-04' */
export function key(y: number, m: number, d: number): DateKey {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

export function parse(k: DateKey): YMD {
  const [y, mo, d] = k.split('-').map(Number);
  return { y, m: mo - 1, d };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** יום השבוע של ה-1 בחודש: 0 = ראשון */
export function firstWeekday(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 1)).getUTCDay();
}

export function isValidKey(k: unknown): k is DateKey {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false;
  const { y, m, d } = parse(k);
  return m >= 0 && m <= 11 && d >= 1 && d <= daysInMonth(y, m);
}

function toUtcMs(k: DateKey): number {
  const { y, m, d } = parse(k);
  return Date.UTC(y, m, d);
}

function fromUtcMs(ms: number): DateKey {
  const dt = new Date(ms);
  return key(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}

export function addDays(k: DateKey, n: number): DateKey {
  const { y, m, d } = parse(k);
  return fromUtcMs(Date.UTC(y, m, d + n));
}

/** diffDays('2026-10-04', '2026-10-10') → 6 (= לילות כש-b הוא יום העזיבה) */
export function diffDays(a: DateKey, b: DateKey): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function addMonths(y: number, m: number, n: number): YearMonth {
  const t = y * 12 + m + n;
  return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
}

export function monthOf(k: DateKey): YearMonth {
  const { y, m } = parse(k);
  return { y, m };
}

/** אינדקס חודש מוחלט — להשוואת חודשים */
export function monthIndex(ym: YearMonth): number {
  return ym.y * 12 + ym.m;
}

/** מספר השורות שחודש צריך בלוח (4–6) */
export function monthRows(y: number, m: number): number {
  return Math.ceil((firstWeekday(y, m) + daysInMonth(y, m)) / 7);
}

/** התאריך המקומי של היום, בלי toISOString */
export function todayKey(now: Date = new Date()): DateKey {
  return key(now.getFullYear(), now.getMonth(), now.getDate());
}

/** '2026-10-04' → '04/10/2026' */
export function formatShort(k: DateKey): string {
  const [y, m, d] = k.split('-');
  return `${d}/${m}/${y}`;
}

/** '2026-10-04' → '4 באוקטובר' או '4 באוקטובר 2026' */
export function formatLong(k: DateKey, withYear: boolean): string {
  const { y, m, d } = parse(k);
  return `${d} ב${MONTH_NAMES_HE[m]}${withYear ? ` ${y}` : ''}`;
}

/** 'אוקטובר 2026' */
export function monthTitle(y: number, m: number): string {
  return `${MONTH_NAMES_HE[m]} ${y}`;
}

/**
 * טקסט הטווח לשדה ולכותרת:
 * "4 באוקטובר – 10 באוקטובר 2026" · "4 באוקטובר 2026 – בחרו תאריך יציאה" · placeholder
 */
export function formatRangeText(
  start: DateKey | null,
  end: DateKey | null,
  placeholder: string = TEXTS.placeholder,
): string {
  if (start && end) {
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    return `${formatLong(start, !sameYear)} – ${formatLong(end, true)}`;
  }
  if (start) return `${formatLong(start, true)} – ${TEXTS.pickDeparture}`;
  return placeholder;
}

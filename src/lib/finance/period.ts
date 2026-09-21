// Month arithmetic of the finance module, on 'YYYY-MM' keys and 'YYYY-MM-DD'
// dates as plain strings — no Date objects, no time zones (a month is a month
// wherever the server runs). Pure; safe on client and server.
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
import { todayInJerusalem } from '@/lib/dates';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonthKey(v: unknown): v is string {
  return typeof v === 'string' && MONTH_KEY_RE.test(v);
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v);
}

/** 'YYYY-MM-DD' → 'YYYY-MM'. */
export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** 'YYYY-MM' → 'YYYY-MM-01' (what fin_entries.period_month stores). */
export function periodMonthOf(monthKey: string): string {
  return `${monthKey}-01`;
}

export function currentMonthKey(): string {
  return monthKeyOf(todayInJerusalem());
}

/** `?m=` → a valid month key, falling back to the current month. */
export function parseMonthParam(v: string | string[] | undefined): string {
  const one = Array.isArray(v) ? v[0] : v;
  return isMonthKey(one) ? one : currentMonthKey();
}

export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** 'ספטמבר 2026'. */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${HE_MONTH_NAMES[m - 1] ?? monthKey} ${y}`;
}

/** { year: '2026', month: '09' } — the Drive folder names. */
export function monthFolderParts(isoDateOrMonth: string): { year: string; month: string } {
  return { year: isoDateOrMonth.slice(0, 4), month: isoDateOrMonth.slice(5, 7) };
}

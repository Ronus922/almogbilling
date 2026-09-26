// Month / period arithmetic of the finance module, on 'YYYY-MM' keys and
// 'YYYY-MM-DD' dates as plain strings — no Date objects, no time zones (a month
// is a month wherever the server runs). Pure; safe on client and server.
//
// A *period* is what the overview's date picker selects: one month, a quarter,
// a half-year or a whole year. Its URL form (`?m=`) is
//   YYYY-MM  · YYYY-Qn (n = 1..4) · YYYY-Hn (n = 1..2) · YYYY
// so the pre-existing month links keep working unchanged.
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
import { todayInJerusalem } from '@/lib/dates';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const QUARTER_KEY_RE = /^(\d{4})-Q([1-4])$/;
const HALF_KEY_RE = /^(\d{4})-H([12])$/;
const YEAR_KEY_RE = /^\d{4}$/;

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

function monthKeyFrom(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
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

/** 'YYYY-MM' → { year, month } as numbers (finance_month_status columns). */
export function monthKeyParts(monthKey: string): { year: number; month: number } {
  const [y, m] = monthKey.split('-').map(Number);
  return { year: y, month: m };
}

// ── Periods ───────────────────────────────────────────────────────────────────

export type PeriodKind = 'month' | 'quarter' | 'half' | 'year';

export interface Period {
  kind: PeriodKind;
  /** The URL form (see the header comment). */
  key: string;
  year: number;
  /** month 1–12 · quarter 1–4 · half 1–2 · year: 1. */
  index: number;
  /** First and last month of the period, 'YYYY-MM', inclusive. */
  from: string;
  to: string;
}

export const HALF_LABEL: Record<number, string> = { 1: 'מחצית א׳', 2: 'מחצית ב׳' };

export function makePeriod(kind: PeriodKind, year: number, index: number): Period {
  switch (kind) {
    case 'month':
      return { kind, key: monthKeyFrom(year, index), year, index, from: monthKeyFrom(year, index), to: monthKeyFrom(year, index) };
    case 'quarter':
      return { kind, key: `${year}-Q${index}`, year, index, from: monthKeyFrom(year, (index - 1) * 3 + 1), to: monthKeyFrom(year, index * 3) };
    case 'half':
      return { kind, key: `${year}-H${index}`, year, index, from: monthKeyFrom(year, (index - 1) * 6 + 1), to: monthKeyFrom(year, index * 6) };
    case 'year':
      return { kind, key: String(year), year, index: 1, from: monthKeyFrom(year, 1), to: monthKeyFrom(year, 12) };
  }
}

/** Any of the four URL forms → a Period, or null when it is none of them. */
export function parsePeriod(v: unknown): Period | null {
  if (typeof v !== 'string') return null;
  if (isMonthKey(v)) {
    const { year, month } = monthKeyParts(v);
    return makePeriod('month', year, month);
  }
  const q = QUARTER_KEY_RE.exec(v);
  if (q) return makePeriod('quarter', Number(q[1]), Number(q[2]));
  const h = HALF_KEY_RE.exec(v);
  if (h) return makePeriod('half', Number(h[1]), Number(h[2]));
  if (YEAR_KEY_RE.test(v)) return makePeriod('year', Number(v), 1);
  return null;
}

/** `?m=` → a Period, falling back to the current month. */
export function parsePeriodParam(v: string | string[] | undefined): Period {
  const one = Array.isArray(v) ? v[0] : v;
  return parsePeriod(one) ?? parsePeriod(currentMonthKey())!;
}

/** Every month key of the period, oldest first. */
export function periodMonthKeys(p: Period): string[] {
  const out: string[] = [];
  for (let m = p.from; m <= p.to; m = shiftMonthKey(m, 1)) out.push(m);
  return out;
}

/** 'ספטמבר 2026' · 'רבעון 3 · 2026' · 'מחצית ב׳ · 2026' · 'כל 2026'. */
export function periodLabel(p: Period): string {
  switch (p.kind) {
    case 'month': return monthLabel(p.key);
    case 'quarter': return `רבעון ${p.index} · ${p.year}`;
    case 'half': return `${HALF_LABEL[p.index]} · ${p.year}`;
    case 'year': return `כל ${p.year}`;
  }
}

// Pure helpers of the owners-portal screens (client-safe, no DB): the
// reference's number / date formats, the URL vocabulary of the tabs and the
// small arithmetic behind the overview (axis, averages, category shares).
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
import { makePeriod, parsePeriod, shiftMonthKey, type Period } from '@/lib/finance/period';
import type { FinKind } from '@/lib/constants/finance';
import type { ResidentEntry } from '@/lib/types/finance';
import type { PortalAccount } from '@/lib/types/portal';

// ── Tabs & URL ────────────────────────────────────────────────────────────────

export const PORTAL_TABS = ['ov', 'tx', 'fund', 'acc', 'dec', 'rep'] as const;
export type PortalTab = (typeof PORTAL_TABS)[number];

/** `?tab=` → a tab. The old portal's `fund` keeps working; anything else is
 *  the overview. `?m=` is the transactions tab's period in all four of its
 *  grammars (month · quarter · half · year), so a link from before the
 *  six-tab shell — which carried the period alone — opens that tab on that
 *  period, exactly where it used to land. The reports tab has its own `?r=`. */
export function parsePortalTab(tab: string | undefined, m: string | undefined): PortalTab {
  if (tab && (PORTAL_TABS as readonly string[]).includes(tab)) return tab as PortalTab;
  if (tab === 'operating') return 'tx';
  if (m && parsePeriod(m)) return 'tx';
  return 'ov';
}

export const OVERVIEW_SPANS = [12, 6] as const;
export type OverviewSpan = (typeof OVERVIEW_SPANS)[number];

export function parseOverviewSpan(v: string | undefined): OverviewSpan {
  return v === '6' ? 6 : 12;
}

export type TxFilter = 'all' | 'in' | 'out';
export function parseTxFilter(v: string | undefined): TxFilter {
  return v === 'in' || v === 'out' ? v : 'all';
}

// ── Formats (the reference's) ────────────────────────────────────────────────

const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Whole shekels for the screen (decision 28/09/2026): ordinary half-up
 *  rounding — 1,240.50 → 1,241, 1,240.49 → 1,240 — done on the absolute
 *  value, so −2.5 rounds away from zero like 2.5 does (Math.round would give
 *  −2). A hair of float noise (1240.4999999999 for a numeric 1,240.50 that
 *  went through float8 or a sum) still rounds up; a real 0.4999 does not.
 *  The sign is kept; a value that rounds to nothing is 0, never −0. */
export function roundShekels(n: number): number {
  const whole = Math.floor(Math.abs(n) + 0.5 + 1e-9);
  return whole === 0 ? 0 : n < 0 ? -whole : whole;
}

/** '₪8,820' — the reference's fmt(): shekel sign, en-US grouping, no space,
 *  always the absolute value (the sign is the caller's: '+' / '−'), and
 *  whole shekels — EVERY amount a resident sees goes through here. Totals,
 *  averages, deltas and shares are computed by the callers from the exact
 *  amounts and rounded here, at the last step, so a ₪1 gap between rounded
 *  lines and their rounded total is normal. The database, the admin screens
 *  and the Excel export keep the agorot. */
export function fmtIls(n: number): string {
  return `₪${group.format(Math.abs(roundShekels(n)))}`;
}

/** A figure that may be negative — a balance, a surplus, a difference: the
 *  sign is decided AFTER rounding ('₪0', never '−₪0'): '₪7,021' / '−₪412'. */
export function fmtSigned(n: number): string {
  return `${roundShekels(n) < 0 ? '−' : ''}${fmtIls(n)}`;
}

/** The colour class of a signed figure, by its rounded value: 'in' (green)
 *  above zero, 'out' (red) below, '' at zero — a difference or a balance is
 *  green when positive and red when negative (decision 28/09/2026). */
export function signClass(n: number): 'in' | 'out' | '' {
  const r = roundShekels(n);
  return r > 0 ? 'in' : r < 0 ? 'out' : '';
}

/** The exact sum of amounts — a total is never a sum of rounded figures. */
export function sumExact(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/** 'DD.MM.YYYY' for a dated line (an expense's payment date); an income has
 *  only its month, so it shows 'MM.YYYY' (Phase 0 finding, 28/09/2026). */
export function fmtEntryDate(e: Pick<ResidentEntry, 'kind' | 'payment_date' | 'period_month'>): string {
  if (e.kind === 'expense' && e.payment_date) {
    const [y, m, d] = e.payment_date.split('-');
    return `${d}.${m}.${y}`;
  }
  return `${e.period_month.slice(5, 7)}.${e.period_month.slice(0, 4)}`;
}

/** The sortable date of a line: the payment date, else the filing month. */
export function entryDateKey(e: Pick<ResidentEntry, 'payment_date' | 'period_month'>): string {
  return e.payment_date ?? e.period_month;
}

/** The reference's short month labels ('ספט׳'), indexed January = 0. */
export const HE_MONTH_SHORT = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'] as const;

export function monthShort(monthKey: string): string {
  return HE_MONTH_SHORT[Number(monthKey.slice(5, 7)) - 1] ?? monthKey;
}

/** 'ספטמבר' — the month name alone (the KPI titles: "הכנסות · ספטמבר"). */
export function monthName(monthKey: string): string {
  return HE_MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1] ?? monthKey;
}

/** 'ספטמבר 2026' */
export function monthTitle(monthKey: string): string {
  return `${monthName(monthKey)} ${monthKey.slice(0, 4)}`;
}

/** "דנה לוי" → "דנה"; null → null. */
export function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first || null;
}

/** "דנה לוי" → "ד״ל" (the reference avatar); one word → its first letter;
 *  no name → "ב״ד" (בעל דירה). */
export function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'ב״ד';
  if (parts.length === 1) return parts[0].charAt(0);
  return `${parts[0].charAt(0)}״${parts[1].charAt(0)}`;
}

/** "דירה 7" · "דירות 1210, 1237, 520". */
export function apartmentsLabel(numbers: readonly string[]): string {
  if (numbers.length === 0) return 'בעל/ת דירה';
  if (numbers.length === 1) return `דירה ${numbers[0]}`;
  return `דירות ${numbers.join(', ')}`;
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** The years that hold a published month, newest first. */
function publishedYears(publishedKeys: readonly string[]): number[] {
  return [...new Set(publishedKeys.map((k) => Number(k.slice(0, 4))))].sort((a, b) => b - a);
}

/** A range is offered only when it holds at least one published month — the
 *  one rule behind both selects below. */
function holdsPublished(published: ReadonlySet<string>): (p: Period) => boolean {
  return (p) => [...published].some((k) => k >= p.from && k <= p.to);
}

/** The period picker of the transactions tab, grouped by year (years newest
 *  first). Inside a year, fine to coarse and newest first in each step: its
 *  PUBLISHED months, then the quarters, the halves and the year itself that
 *  hold one. A month nobody published is not in the list at all, so it cannot
 *  be picked — and neither can an empty quarter, half or year. */
export function periodOptionsByYear(publishedKeys: readonly string[]): Array<{ year: number; periods: Period[] }> {
  const published = new Set(publishedKeys);
  const has = holdsPublished(published);
  const newestFirst = [...publishedKeys].sort().reverse();
  return publishedYears(publishedKeys).map((year) => {
    const periods: Period[] = newestFirst
      .filter((k) => Number(k.slice(0, 4)) === year)
      .map((k) => makePeriod('month', year, Number(k.slice(5, 7))));
    for (const q of [4, 3, 2, 1]) { const p = makePeriod('quarter', year, q); if (has(p)) periods.push(p); }
    for (const h of [2, 1]) { const p = makePeriod('half', year, h); if (has(p)) periods.push(p); }
    const whole = makePeriod('year', year, 1);
    if (has(whole)) periods.push(whole);
    return { year, periods };
  });
}

/** Every quarter, half and year that holds at least one published month —
 *  the reports select. Newest first; inside a year: the year, then halves,
 *  then quarters (all newest first). */
export function reportRanges(publishedKeys: readonly string[]): Period[] {
  const has = holdsPublished(new Set(publishedKeys));
  const out: Period[] = [];
  for (const y of publishedYears(publishedKeys)) {
    const candidates: Period[] = [
      makePeriod('year', y, 1),
      makePeriod('half', y, 2), makePeriod('half', y, 1),
      makePeriod('quarter', y, 4), makePeriod('quarter', y, 3), makePeriod('quarter', y, 2), makePeriod('quarter', y, 1),
    ];
    for (const p of candidates) if (has(p)) out.push(p);
  }
  return out;
}

/** `?r=` → the report range to show: the requested one when it is in the
 *  list, else the first (newest) one, else null (nothing published). */
export function reportRangeFor(r: string | undefined, ranges: readonly Period[]): Period | null {
  if (ranges.length === 0) return null;
  const requested = r ? parsePeriod(r) : null;
  if (requested && requested.kind !== 'month') {
    const hit = ranges.find((p) => p.key === requested.key);
    if (hit) return hit;
  }
  return ranges[0];
}

// ── Overview arithmetic ──────────────────────────────────────────────────────

/** The last `span` months up to `latest` ('YYYY-MM' keys, oldest first). */
export function windowKeys(latest: string, span: number): string[] {
  const out: string[] = [];
  for (let i = span - 1; i >= 0; i -= 1) out.push(shiftMonthKey(latest, -i));
  return out;
}

/** Percent change of `value` against the mean of `values` (the period's
 *  average). null when there is nothing to compare with (empty, or a zero
 *  mean). Rounded to a whole percent. */
export function pctVsAverage(value: number, values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return null;
  return Math.round(((value - mean) / mean) * 100);
}

/** A "nice" axis for a bar chart: the top gridline and the step between the
 *  four gridlines (0, step, 2·step, 3·step, 4·step ≥ max). */
export function niceAxis(max: number): { max: number; step: number } {
  if (!(max > 0)) return { max: 4, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  return { max: step * 4, step };
}

/** Axis label: '0' · '500' · '3.5K' · '120K' · '1.2M'. */
export function axisLabel(v: number): string {
  if (v === 0) return '0';
  if (v >= 1_000_000) return `${trimNum(v / 1_000_000)}M`;
  if (v >= 1000) return `${trimNum(v / 1000)}K`;
  return trimNum(v);
}

function trimNum(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export interface CategoryShare {
  name: string;
  total: number;
  /** Share of the sum of all categories, 0–100 (whole percent). */
  pct: number;
  /** Relative to the largest category, 0–100 (the bar width). */
  bar: number;
}

/** Categories sorted largest first with their share of the total and their
 *  width against the largest — the reference's "לאן הולך הכסף" list. Zero
 *  categories are dropped. */
export function categoryShares(items: ReadonlyArray<{ name: string; total: number }>): CategoryShare[] {
  const list = items.filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const sum = list.reduce((s, c) => s + c.total, 0);
  const top = list[0]?.total ?? 0;
  return list.map((c) => ({
    name: c.name,
    total: c.total,
    pct: sum > 0 ? Math.round((c.total / sum) * 100) : 0,
    bar: top > 0 ? (c.total / top) * 100 : 0,
  }));
}

/** Sum a category's by_month over the window keys. */
export function sumOverWindow(byMonth: Record<string, number>, keys: readonly string[]): number {
  return keys.reduce((s, k) => s + (byMonth[k] ?? 0), 0);
}

/** The month's lines of one kind grouped by category, largest first. */
export function categoriesOf(entries: readonly ResidentEntry[], kind: FinKind): CategoryShare[] {
  const map = new Map<string, number>();
  for (const e of entries) if (e.kind === kind) map.set(e.category_name, (map.get(e.category_name) ?? 0) + e.amount);
  return categoryShares([...map.entries()].map(([name, total]) => ({ name, total })));
}

/** The reference's category palette, by rank. */
export const CAT_COLORS = ['#3D5AFE', '#7C4DFF', '#0EA5E9', '#F59E0B', '#12A150', '#94A3B8'] as const;

export function catColor(i: number): string {
  return CAT_COLORS[i] ?? CAT_COLORS[CAT_COLORS.length - 1];
}

/** Lines of a month as one flat, newest-first list for the table. */
export function flatEntries(entries: readonly ResidentEntry[], filter: TxFilter): ResidentEntry[] {
  const list = entries.filter((e) => filter === 'all' || (filter === 'in' ? e.kind === 'income' : e.kind === 'expense'));
  return [...list].sort((a, b) => entryDateKey(b).localeCompare(entryDateKey(a)) || (a.kind === b.kind ? 0 : a.kind === 'income' ? -1 : 1));
}

// ── "החשבון שלי" ─────────────────────────────────────────────────────────────

/** An ISO timestamp → 'DD.MM.YYYY' in Asia/Jerusalem ("נכון ל-…"). */
export function fmtDateDMY(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}`;
}

/** The figures of the dark "היתרה שלך לתשלום" card: the exact sums over the
 *  owner's records (one per apartment); the card rounds them when it shows
 *  them. */
export function accountTotals(accounts: readonly PortalAccount[]): { total: number; management: number; hotWater: number } {
  return {
    total: sumExact(accounts.map((a) => a.total_debt)),
    management: sumExact(accounts.map((a) => a.management_fees)),
    hotWater: sumExact(accounts.map((a) => a.hot_water_debt)),
  };
}

/** '+₪2,140' / '−₪2,140' / '₪0' — the KPI's "מול החודש הקודם" delta, its
 *  sign decided after rounding (a delta of 0.3 is '₪0', not '+₪0'). */
export function fmtDelta(n: number): string {
  const r = roundShekels(n);
  if (r > 0) return `+${fmtIls(r)}`;
  if (r < 0) return `−${fmtIls(r)}`;
  return fmtIls(0);
}

// ── Excel ────────────────────────────────────────────────────────────────────

/** A text cell that a spreadsheet would read as a formula (= + - @, or a
 *  leading tab / CR) is neutralised with a leading apostrophe — the cell shows
 *  the text, and nothing executes when the file is opened. Numbers are never
 *  passed through here. */
export function sanitizeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

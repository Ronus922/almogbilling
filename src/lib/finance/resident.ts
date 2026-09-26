// The resident view ("תצוגת דייר") of /finance — pure helpers, safe on client
// and server. A resident sees published months only: the period they land on
// is the requested one when it holds published data, otherwise the newest
// published month; nothing published yet = null (the empty screen).
import { makePeriod, monthKeyParts, parsePeriod, type Period } from './period';

/** finance_month_status rows → 'YYYY-MM' keys, newest first. */
export function publishedMonthKeys(rows: ReadonlyArray<{ year: number; month: number }>): string[] {
  return [...rows]
    .map((r) => `${String(r.year).padStart(4, '0')}-${String(r.month).padStart(2, '0')}`)
    .sort()
    .reverse();
}

/** At least one published month inside [from, to]. */
export function rangeHasPublished(from: string, to: string, published: ReadonlySet<string>): boolean {
  for (const k of published) if (k >= from && k <= to) return true;
  return false;
}

/** Whether a resident may open this period: a month must itself be
 *  published; a quarter / half / year needs one published month inside it. */
export function periodOpenToResidents(p: Period, published: ReadonlySet<string>): boolean {
  return p.kind === 'month' ? published.has(p.key) : rangeHasPublished(p.from, p.to, published);
}

/** The period the resident view shows for `?m=`: the requested period when it
 *  is open to residents, else the newest published month, else null. */
export function residentPeriodFor(m: string | string[] | undefined, publishedKeys: readonly string[]): Period | null {
  if (publishedKeys.length === 0) return null;
  const published = new Set(publishedKeys);
  const requested = parsePeriod(Array.isArray(m) ? m[0] : m);
  if (requested && periodOpenToResidents(requested, published)) return requested;
  const newest = [...publishedKeys].sort().reverse()[0]!;
  const { year, month } = monthKeyParts(newest);
  return makePeriod('month', year, month);
}

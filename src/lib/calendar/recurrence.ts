// Recurrence materialization — pure date math (no DB, no server-only).
// Saving a recurring event expands the rule into concrete occurrence DATES,
// capped at MAX_OCCURRENCES or MAX_MONTHS_AHEAD, whichever is hit first.

import type { RecurrenceRule, RecurrenceType } from '@/lib/types/calendar';

/** Hard ceiling on materialized occurrences per series. */
export const MAX_OCCURRENCES = 78;
/** Hard ceiling on how far ahead (months) occurrences are generated. */
export const MAX_MONTHS_AHEAD = 18;

/** Parse 'YYYY-MM-DD' into a UTC-midnight Date (timezone-stable date math). */
export function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject overflow dates like 2026-02-31.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/** Format a UTC Date back to 'YYYY-MM-DD'. */
function formatDateOnly(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Advance a UTC date by `step` units of `type`. Returns a NEW Date. */
function advance(base: Date, type: RecurrenceType, step: number): Date {
  const d = new Date(base.getTime());
  switch (type) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + step);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + step * 7);
      break;
    case 'monthly': {
      // Anchor on the original day-of-month; clamp to month length (e.g. the
      // 31st recurring monthly lands on the 30th/28th where the 31st is absent).
      const anchorDay = base.getUTCDate();
      const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + step, 1));
      const daysInMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(anchorDay, daysInMonth));
      return target;
    }
    case 'yearly': {
      const target = new Date(Date.UTC(base.getUTCFullYear() + step, base.getUTCMonth(), 1));
      const anchorDay = base.getUTCDate();
      const daysInMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(anchorDay, daysInMonth));
      return target;
    }
  }
  return d;
}

export interface ExpandResult {
  /** Occurrence dates as 'YYYY-MM-DD', INCLUDING the seed date as the first. */
  dates: string[];
  /** True if the cap (count of occurrences / months ahead) clipped the series. */
  capped: boolean;
}

/**
 * Expand a recurrence rule starting at `startDate` ('YYYY-MM-DD').
 * The seed date is always the first occurrence. Returns concrete dates.
 *
 * Caps: MAX_OCCURRENCES total, and MAX_MONTHS_AHEAD from the seed — whichever
 * is reached first. `endType='count'` is itself clamped to MAX_OCCURRENCES;
 * `endType='until_date'` is clamped to the month ceiling.
 */
export function expandRecurrence(startDate: string, rule: RecurrenceRule): ExpandResult {
  const seed = parseDateOnly(startDate);
  if (!seed) return { dates: [], capped: false };

  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const horizon = new Date(seed.getTime());
  horizon.setUTCMonth(horizon.getUTCMonth() + MAX_MONTHS_AHEAD);

  const until =
    rule.endType === 'until_date' && rule.untilDate ? parseDateOnly(rule.untilDate) : null;

  const hardCount =
    rule.endType === 'count' && rule.count && rule.count > 0
      ? Math.min(rule.count, MAX_OCCURRENCES)
      : MAX_OCCURRENCES;

  const dates: string[] = [];
  let capped = false;
  let step = 0;

  // Guard loop: never iterate more than a generous multiple of the ceiling.
  for (let guard = 0; guard < MAX_OCCURRENCES * 4 + 10; guard++) {
    const occ = step === 0 ? seed : advance(seed, rule.type, step * interval);

    if (occ.getTime() > horizon.getTime()) {
      capped = true;
      break;
    }
    if (until && occ.getTime() > until.getTime()) {
      break; // reached the until-date cleanly (not a cap)
    }

    dates.push(formatDateOnly(occ));

    if (dates.length >= hardCount) {
      // Hit the count limit. It's a "cap" only if the rule wanted more than the ceiling.
      if (rule.endType === 'count' && rule.count && rule.count > MAX_OCCURRENCES) capped = true;
      if (rule.endType === 'never') capped = true;
      break;
    }
    step++;
  }

  return { dates, capped };
}

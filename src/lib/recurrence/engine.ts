// Task-recurrence engine — pure date math (no DB, no server-only).
// Safe to import anywhere (UI, validation, tests). The HORIZON model expands a
// rule into the concrete occurrence DATES inside [anchor, horizon]; the
// server-side materializer (src/lib/recurrence/materialize.ts) turns those dates
// into task rows.

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RecurrenceEndType = 'never' | 'on_date' | 'after_count';

/** Canonical recurrence rule — also the validated client→server payload shape
 *  (camelCase). The DB row (snake_case) maps onto this. */
export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Repeat every N units of `frequency`. >= 1. */
  interval: number;
  /** 0=Sunday .. 6=Saturday. Only meaningful for weekly; null otherwise. */
  byweekday: number[] | null;
  endType: RecurrenceEndType;
  /** 'YYYY-MM-DD' when endType==='on_date'. */
  endDate: string | null;
  /** Total occurrence cap when endType==='after_count'. */
  endCount: number | null;
}

/** How far ahead instances are materialized (days from "today"). */
export const HORIZON_DAYS = 45;
/** Hard ceiling on occurrences computed per call (runaway guard, ~1y daily). */
export const MAX_OCCURRENCES = 366;

// ── Date-only helpers (UTC-midnight → timezone-stable date math) ─────────────

/** Parse 'YYYY-MM-DD' into a UTC-midnight Date. Rejects overflow (e.g. 02-31). */
export function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/** Format a UTC Date back to 'YYYY-MM-DD'. */
export function formatDateOnly(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addDaysUTC(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Advance a UTC date by `step` units of daily/monthly/yearly. (weekly is
 *  handled separately because of byweekday fan-out.) Month/year anchor on the
 *  original day-of-month, clamped to the target month length. */
function advance(base: Date, freq: RecurrenceFrequency, step: number): Date {
  switch (freq) {
    case 'daily':
      return addDaysUTC(base, step);
    case 'weekly':
      return addDaysUTC(base, step * 7);
    case 'monthly':
    case 'yearly': {
      const monthsStep = freq === 'yearly' ? step * 12 : step;
      const anchorDay = base.getUTCDate();
      const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthsStep, 1));
      const daysInMonth = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      target.setUTCDate(Math.min(anchorDay, daysInMonth));
      return target;
    }
  }
}

/**
 * Compute the concrete occurrence dates of a recurrence rule inside
 * [anchorDate, horizonDate] (both inclusive). `anchorDate` is the series origin
 * (the template's due date) — counts and intervals are measured from it.
 *
 * Semantics:
 *  - daily/monthly/yearly: a single track stepping `interval` units from anchor.
 *  - weekly: every `interval` weeks, on each weekday in `byweekday` (0=Sun..6=Sat);
 *    empty/null byweekday → the anchor's own weekday. Days before the anchor in
 *    the first week are skipped.
 *  - endType 'never'    → up to the horizon (and MAX_OCCURRENCES).
 *  - endType 'on_date'  → up to min(endDate, horizon).
 *  - endType 'after_count' → the first `endCount` occurrences (excluded dates
 *    still consume the count, matching iCal COUNT semantics), within horizon.
 *  - `excludedDates` ('YYYY-MM-DD' set, from the rule's exceptions) are removed
 *    AFTER counting, so a skipped date does not shift later occurrences.
 *
 * Pure & deterministic. Returns ascending UTC-midnight Dates.
 */
export function computeOccurrences(
  rule: RecurrenceRule,
  anchorDate: Date,
  horizonDate: Date,
  excludedDates: ReadonlySet<string> = new Set(),
): Date[] {
  const anchor = new Date(Date.UTC(
    anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), anchorDate.getUTCDate(),
  ));
  const horizon = new Date(Date.UTC(
    horizonDate.getUTCFullYear(), horizonDate.getUTCMonth(), horizonDate.getUTCDate(),
  ));
  if (horizon.getTime() < anchor.getTime()) return [];

  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const endDate =
    rule.endType === 'on_date' && rule.endDate ? parseDateOnly(rule.endDate) : null;
  const hardCount =
    rule.endType === 'after_count' && rule.endCount && rule.endCount > 0
      ? Math.min(Math.floor(rule.endCount), MAX_OCCURRENCES)
      : MAX_OCCURRENCES;

  const raw: Date[] = []; // ascending, before exception filtering

  const within = (occ: Date): boolean => {
    if (occ.getTime() > horizon.getTime()) return false;
    if (endDate && occ.getTime() > endDate.getTime()) return false;
    return true;
  };

  if (rule.frequency === 'weekly') {
    const weekdays = (rule.byweekday && rule.byweekday.length > 0
      ? [...new Set(rule.byweekday)].filter((d) => d >= 0 && d <= 6)
      : [anchor.getUTCDay()]
    ).sort((a, b) => a - b);
    // Sunday of the anchor's week → the week grid origin.
    const anchorWeekStart = addDaysUTC(anchor, -anchor.getUTCDay());
    let week = 0;
    const weekGuard = MAX_OCCURRENCES + 8;
    weekloop: for (; week < weekGuard; week++) {
      const weekStart = addDaysUTC(anchorWeekStart, week * interval * 7);
      // Earliest day of this active week is its Sunday — if that's past the
      // horizon, every later day is too.
      if (weekStart.getTime() > horizon.getTime()) break;
      for (const wd of weekdays) {
        const occ = addDaysUTC(weekStart, wd);
        if (occ.getTime() < anchor.getTime()) continue; // before the series start
        if (!within(occ)) break weekloop; // ascending → nothing further qualifies
        raw.push(occ);
        if (raw.length >= hardCount) break weekloop;
      }
    }
  } else {
    let step = 0;
    const stepGuard = MAX_OCCURRENCES + 8;
    for (; step < stepGuard; step++) {
      const occ = step === 0 ? anchor : advance(anchor, rule.frequency, step * interval);
      if (!within(occ)) break;
      raw.push(occ);
      if (raw.length >= hardCount) break;
    }
  }

  return raw.filter((d) => !excludedDates.has(formatDateOnly(d)));
}

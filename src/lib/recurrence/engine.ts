// Task-recurrence engine — pure date math (no DB, no server-only).
// Safe to import anywhere (UI, validation, tests).
//
// SINGLE-ROW model (migration 067): a recurring task is ONE tasks row whose
// due_date points at the current occurrence. Nothing is materialized ahead of
// time. `computeOccurrences` expands a rule into concrete dates for *reading*
// (which occurrence is next, what falls inside the current period);
// `nextOccurrenceAfter` is the one the series row advances on.

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

/** How far ahead a lookup scans for a series' next occurrence. Generous enough
 *  to clear a yearly gap (and any `interval` up to a year) in one pass. */
export const SERIES_LOOKAHEAD_DAYS = 400;
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

/** Strip any time component → UTC midnight, so all comparisons are date-only. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `a` to `b` (both UTC-midnight). Negative when b precedes a. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Whole calendar months from `a` to `b`. Negative when b precedes a. */
function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
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
 * `fromDate` raises the lower bound WITHOUT re-anchoring: the step arithmetic
 * still runs off `anchorDate` (so month-length clamping never drifts and the
 * weekly phase is preserved), we just fast-forward to the first step at or after
 * it and drop anything below. That matters for long-lived series — a daily task
 * anchored three years ago would otherwise exhaust MAX_OCCURRENCES before ever
 * reaching today. Ignored for endType 'after_count', where the count must be
 * measured from the anchor.
 *
 * Pure & deterministic. Returns ascending UTC-midnight Dates.
 */
export function computeOccurrences(
  rule: RecurrenceRule,
  anchorDate: Date,
  horizonDate: Date,
  excludedDates: ReadonlySet<string> = new Set(),
  fromDate?: Date,
): Date[] {
  const anchor = utcMidnight(anchorDate);
  const horizon = utcMidnight(horizonDate);
  if (horizon.getTime() < anchor.getTime()) return [];

  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const endDate =
    rule.endType === 'on_date' && rule.endDate ? parseDateOnly(rule.endDate) : null;
  const hardCount =
    rule.endType === 'after_count' && rule.endCount && rule.endCount > 0
      ? Math.min(Math.floor(rule.endCount), MAX_OCCURRENCES)
      : MAX_OCCURRENCES;

  // 'after_count' counts from the anchor, so it can never skip ahead. Its own
  // cap (<= MAX_OCCURRENCES) keeps the scan bounded anyway.
  const from =
    fromDate && rule.endType !== 'after_count'
      ? new Date(Math.max(utcMidnight(fromDate).getTime(), anchor.getTime()))
      : anchor;

  const raw: Date[] = []; // ascending, before exception filtering

  const within = (occ: Date): boolean => {
    if (occ.getTime() > horizon.getTime()) return false;
    if (endDate && occ.getTime() > endDate.getTime()) return false;
    return true;
  };

  const guard = MAX_OCCURRENCES + 8;

  if (rule.frequency === 'weekly') {
    const weekdays = (rule.byweekday && rule.byweekday.length > 0
      ? [...new Set(rule.byweekday)].filter((d) => d >= 0 && d <= 6)
      : [anchor.getUTCDay()]
    ).sort((a, b) => a - b);
    // Sunday of the anchor's week → the week grid origin.
    const anchorWeekStart = addDaysUTC(anchor, -anchor.getUTCDay());
    const weekSpan = interval * 7;
    // Both are Sundays, so the gap is a whole number of weeks → the floor lands
    // on the active week containing (or preceding) `from`.
    const startWeek = Math.max(
      0,
      Math.floor(daysBetween(anchorWeekStart, addDaysUTC(from, -from.getUTCDay())) / weekSpan),
    );
    weekloop: for (let week = startWeek; week < startWeek + guard; week++) {
      const weekStart = addDaysUTC(anchorWeekStart, week * weekSpan);
      // Earliest day of this active week is its Sunday — if that's past the
      // horizon, every later day is too.
      if (weekStart.getTime() > horizon.getTime()) break;
      for (const wd of weekdays) {
        const occ = addDaysUTC(weekStart, wd);
        if (occ.getTime() < anchor.getTime()) continue; // before the series start
        if (!within(occ)) break weekloop; // ascending → nothing further qualifies
        if (occ.getTime() >= from.getTime()) raw.push(occ);
        if (raw.length >= hardCount) break weekloop;
      }
    }
  } else {
    // occ(step) = advance(anchor, freq, step * interval) — a closed form, so the
    // start step can be solved for instead of walked to.
    const elapsed =
      rule.frequency === 'daily'
        ? daysBetween(anchor, from)
        : monthsBetween(anchor, from) / (rule.frequency === 'yearly' ? 12 : 1);
    const startStep = Math.max(0, Math.floor(elapsed / interval));
    for (let step = startStep; step < startStep + guard; step++) {
      const occ = step === 0 ? anchor : advance(anchor, rule.frequency, step * interval);
      if (!within(occ)) break;
      if (occ.getTime() >= from.getTime()) raw.push(occ);
      if (raw.length >= hardCount) break;
    }
  }

  return raw.filter((d) => !excludedDates.has(formatDateOnly(d)));
}

/** Days the rule spans between two consecutive occurrences (upper bound) — sets
 *  how far `nextOccurrenceAfter` has to look before declaring a series done. */
function ruleSpanDays(rule: RecurrenceRule): number {
  const i = Math.max(1, Math.floor(rule.interval || 1));
  switch (rule.frequency) {
    case 'daily':
      return i;
    case 'weekly':
      return i * 7;
    case 'monthly':
      return i * 31;
    case 'yearly':
      return i * 366;
  }
}

/** Hard ceiling on the lookahead window — a series with nothing scheduled inside
 *  it is treated as finished (five years covers any real maintenance cadence). */
const MAX_LOOKAHEAD_DAYS = 366 * 5;

/**
 * The first occurrence STRICTLY AFTER `afterDate` — what the single series row
 * advances its due_date to on completion / skip. Returns 'YYYY-MM-DD', or null
 * when the series has no occurrence left (endType 'after_count' exhausted,
 * 'on_date' passed, or nothing scheduled inside the lookahead window).
 */
export function nextOccurrenceAfter(
  rule: RecurrenceRule,
  anchorDate: Date,
  afterDate: Date,
  excludedDates: ReadonlySet<string> = new Set(),
): string | null {
  const after = utcMidnight(afterDate);
  const lookahead = Math.min(
    MAX_LOOKAHEAD_DAYS,
    Math.max(SERIES_LOOKAHEAD_DAYS, ruleSpanDays(rule) * 2 + 31),
  );
  const occurrences = computeOccurrences(
    rule,
    anchorDate,
    addDaysUTC(after, lookahead),
    excludedDates,
    addDaysUTC(after, 1),
  );
  // `fromDate` is deliberately ignored for 'after_count' (the count is measured
  // from the anchor), so the "> after" filter has to be applied here too.
  const next = occurrences.find((d) => d.getTime() > after.getTime());
  return next ? formatDateOnly(next) : null;
}

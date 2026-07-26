// Cadence derivation — the single source of truth for how a recurrence rule is
// DISPLAYED. Pure date/string math (no DB, no server-only), so it is safe in
// client components, the server DB layer and tests alike.
//
// KEY IDEA: everything the recurrence strip shows is derived from the rule plus
// its anchor date. There are deliberately NO bymonth / bymonthday columns —
//   * monthly, anchor 2026-08-15  → "כל חודש"     + "ב-15 לחודש"
//   * monthly interval 3, anchor month 10 → "כל רבעון"   + months 10, 1, 4, 7
//   * monthly interval 6, anchor month 9  → "כל חצי שנה" + months 9, 3
// which is exactly what the reference design shows, with no schema surface.

import {
  parseDateOnly,
  formatDateOnly,
  type RecurrenceFrequency,
  type RecurrenceRule,
} from '@/lib/recurrence/engine';

/** 0=Sunday .. 6=Saturday — RTL day pills (the Hebrew week starts Sunday). */
export const HE_WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/**
 * The cadence a rule reads as. `quarterly` / `half_yearly` are not stored — they
 * are `monthly` with interval 3 / 6. `custom` is any rule that doesn't map onto a
 * named cadence (e.g. every 5 days) and therefore gets a label but no chips.
 */
export type CadenceKind =
  | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'custom';

export type ChipState = 'off' | 'on' | 'done';

/** What the recurrence strip renders next to the cadence label. */
export type ChipStrip =
  | { type: 'weekdays'; days: { index: number; label: string; state: ChipState }[] }
  | { type: 'monthday'; label: string }
  | { type: 'months'; months: { month: number; state: ChipState }[] }
  | { type: 'none' };

/** The window the chips' "done" state and the progress badge are measured over. */
export interface CadenceWindow {
  from: string; // 'YYYY-MM-DD' inclusive
  to: string;   // 'YYYY-MM-DD' inclusive
  /** Hebrew suffix for the progress badge — "1/3 השבוע". */
  label: string;
}

function normInterval(interval: number): number {
  return Math.max(1, Math.floor(interval || 1));
}

/** Map the stored (frequency, interval) pair onto the cadence it reads as. */
export function cadenceKind(frequency: RecurrenceFrequency, interval: number): CadenceKind {
  const i = normInterval(interval);
  if (frequency === 'daily') return i === 1 ? 'daily' : 'custom';
  if (frequency === 'weekly') return i === 1 ? 'weekly' : 'custom';
  if (frequency === 'yearly') return i === 1 ? 'yearly' : 'custom';
  // monthly — the interval is what makes it a quarter / half-year / year.
  switch (i) {
    case 1: return 'monthly';
    case 3: return 'quarterly';
    case 6: return 'half_yearly';
    case 12: return 'yearly';
    default: return 'custom';
  }
}

const KIND_LABELS: Record<Exclude<CadenceKind, 'custom'>, string> = {
  daily: 'כל יום',
  weekly: 'כל שבוע',
  monthly: 'כל חודש',
  quarterly: 'כל רבעון',
  half_yearly: 'כל חצי שנה',
  yearly: 'כל שנה',
};

const UNIT_PLURAL: Record<RecurrenceFrequency, string> = {
  daily: 'ימים',
  weekly: 'שבועות',
  monthly: 'חודשים',
  yearly: 'שנים',
};

/** Compact Hebrew cadence label — "כל שבוע", "כל רבעון", "כל 5 ימים". */
export function cadenceLabel(frequency: RecurrenceFrequency, interval: number): string {
  const kind = cadenceKind(frequency, interval);
  if (kind !== 'custom') return KIND_LABELS[kind];
  return `כל ${normInterval(interval)} ${UNIT_PLURAL[frequency]}`;
}

// ── Windows ─────────────────────────────────────────────────────────────────

function weekWindow(today: Date): CadenceWindow {
  const sunday = new Date(today.getTime());
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  const saturday = new Date(sunday.getTime());
  saturday.setUTCDate(saturday.getUTCDate() + 6);
  return { from: formatDateOnly(sunday), to: formatDateOnly(saturday), label: 'השבוע' };
}

function monthWindow(today: Date): CadenceWindow {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return {
    from: formatDateOnly(new Date(Date.UTC(y, m, 1))),
    to: formatDateOnly(new Date(Date.UTC(y, m + 1, 0))),
    label: 'החודש',
  };
}

function yearWindow(today: Date): CadenceWindow {
  const y = today.getUTCFullYear();
  return {
    from: formatDateOnly(new Date(Date.UTC(y, 0, 1))),
    to: formatDateOnly(new Date(Date.UTC(y, 11, 31))),
    label: 'השנה',
  };
}

/**
 * The period the cadence is naturally counted over: a week for day-grid
 * cadences, a month for monthly, the calendar year for quarter/half-year/year.
 * null for `custom` — nothing meaningful to aggregate. `today` is 'YYYY-MM-DD'
 * (Asia/Jerusalem — see src/lib/dates.ts).
 */
export function cadenceWindow(
  frequency: RecurrenceFrequency,
  interval: number,
  today: string,
): CadenceWindow | null {
  const t = parseDateOnly(today);
  if (!t) return null;
  switch (cadenceKind(frequency, interval)) {
    case 'daily':
    case 'weekly':
      return weekWindow(t);
    case 'monthly':
      return monthWindow(t);
    case 'quarterly':
    case 'half_yearly':
    case 'yearly':
      return yearWindow(t);
    case 'custom':
      return null;
  }
}

/**
 * How many occurrences the rule expects inside one `cadenceWindow`. The progress
 * badge is only worth showing when this is > 1 — which is why the reference shows
 * "1/3 השבוע" on the 3-day weekly card and nothing on the monthly ones.
 */
export function expectedPerPeriod(rule: Pick<RecurrenceRule, 'frequency' | 'interval' | 'byweekday'>): number {
  switch (cadenceKind(rule.frequency, rule.interval)) {
    case 'daily':
      return 7;
    case 'weekly':
      return rule.byweekday && rule.byweekday.length > 0 ? rule.byweekday.length : 1;
    case 'monthly':
      return 1;
    case 'quarterly':
      return 4;
    case 'half_yearly':
      return 2;
    case 'yearly':
      return 1;
    case 'custom':
      return 0;
  }
}

// ── Chips ───────────────────────────────────────────────────────────────────

/** The months a bymonth-style cadence lands on, derived from the anchor month. */
function derivedMonths(anchorMonth1: number, stepMonths: number): number[] {
  const out: number[] = [];
  for (let m = 0; m < 12; m += stepMonths) {
    out.push(((anchorMonth1 - 1 + m) % 12) + 1);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The chip strip for a rule. `doneOccurrences` are the completion dates inside
 * the current `cadenceWindow` — each one turns its weekday / month chip green.
 * Returns `{type:'none'}` when the anchor is unparseable or the cadence has no
 * meaningful grid (custom intervals).
 */
export function cadenceChips(
  rule: Pick<RecurrenceRule, 'frequency' | 'interval' | 'byweekday'>,
  anchorDate: string,
  doneOccurrences: readonly string[] = [],
): ChipStrip {
  const anchor = parseDateOnly(anchorDate);
  if (!anchor) return { type: 'none' };

  const kind = cadenceKind(rule.frequency, rule.interval);
  const doneDates = doneOccurrences
    .map((d) => parseDateOnly(d))
    .filter((d): d is Date => d !== null);

  // Day grid — daily lights every day; weekly lights the selected days (falling
  // back to the anchor's own weekday, matching the engine).
  if (kind === 'daily' || rule.frequency === 'weekly') {
    const active = new Set<number>(
      kind === 'daily'
        ? [0, 1, 2, 3, 4, 5, 6]
        : rule.byweekday && rule.byweekday.length > 0
          ? rule.byweekday
          : [anchor.getUTCDay()],
    );
    const doneWeekdays = new Set(doneDates.map((d) => d.getUTCDay()));
    return {
      type: 'weekdays',
      days: HE_WEEKDAYS_SHORT.map((label, index) => ({
        index,
        label,
        state: !active.has(index) ? 'off' : doneWeekdays.has(index) ? 'done' : 'on',
      })),
    };
  }

  if (kind === 'monthly') {
    return { type: 'monthday', label: `ב-${anchor.getUTCDate()} לחודש` };
  }

  if (kind === 'quarterly' || kind === 'half_yearly' || kind === 'yearly') {
    const step = kind === 'quarterly' ? 3 : kind === 'half_yearly' ? 6 : 12;
    const active = new Set(derivedMonths(anchor.getUTCMonth() + 1, step));
    const doneMonths = new Set(doneDates.map((d) => d.getUTCMonth() + 1));
    return {
      type: 'months',
      months: Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        return {
          month,
          state: (!active.has(month) ? 'off' : doneMonths.has(month) ? 'done' : 'on') as ChipState,
        };
      }),
    };
  }

  return { type: 'none' };
}

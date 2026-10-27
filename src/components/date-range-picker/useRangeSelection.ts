/**
 * useRangeSelection — כל לוגיקת הבחירה: start/end/hover/base, pick, setNights, cancel, commit.
 * תרגום ישיר של pick / setN / effEnd / build מהדמו (reference/extracted-source.md).
 * הפונקציות הטהורות מיוצאות בנפרד כדי שאפשר יהיה לבדוק אותן בלי React.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DateRange } from './types';
import {
  addDays, daysInMonth, diffDays, firstWeekday, formatLong, key, monthRows, monthTitle,
  type DateKey, type YearMonth,
} from './dateUtils';

export interface RangeRules {
  minDate?: string;
  maxDate?: string;
  /** אופציונלי: בלי ערך — אין מקסימום לילות */
  maxNights?: number;
  isDateDisabled?: (d: string) => boolean;
}

/** המינימום הוא תמיד לילה אחד */
export const MIN_NIGHTS = 1;

export const DEFAULT_RULES: RangeRules = {};

/** תאריך חסום: מחוץ ל-[minDate, maxDate] או חסום נקודתית. מצויר אפור עם קו חוצה, לא לחיץ. */
export function isDateBlocked(k: DateKey, rules: RangeRules): boolean {
  if (rules.minDate && k < rules.minDate) return true;
  if (rules.maxDate && k > rules.maxDate) return true;
  return rules.isDateDisabled?.(k) ?? false;
}

/** האם אפשר ללחוץ על התא: כל תאריך שאינו חסום. */
export function isDateSelectable(k: DateKey, rules: RangeRules): boolean {
  return !isDateBlocked(k, rules);
}

/**
 * תאריך היציאה בפועל עבור מועמד: הטווח לא חוצה תאריך חסום —
 * אם יש חסימה בין ההגעה למועמד, היציאה נקבעת לתאריך החסום הראשון.
 * (הלילה האחרון הוא היום שלפני החסימה; יום העזיבה עצמו יכול להיות היום החסום.)
 */
export function resolveEnd(start: DateKey, candidate: DateKey, rules: RangeRules): DateKey | null {
  let end = candidate;
  if (rules.maxDate && end > rules.maxDate) end = rules.maxDate;
  if (end <= start) return null;
  if (rules.isDateDisabled) {
    for (let k = addDays(start, 1); k <= end; k = addDays(k, 1)) {
      if (rules.isDateDisabled(k)) return k;
    }
  }
  return end;
}

/**
 * pick — לחיצה על יום:
 * 1. אין בחירה / יש טווח מלא → היום הופך להגעה, היציאה מתאפסת.
 * 2. יש רק הגעה: מאוחר יותר → יציאה; זהה או מוקדם → מחליף את ההגעה.
 */
export function pickRange(range: DateRange, k: DateKey, rules: RangeRules = DEFAULT_RULES): DateRange {
  if (!range.start || range.end) return { start: k, end: null };
  if (k <= range.start) return { start: k, end: null };
  return { start: range.start, end: resolveEnd(range.start, k, rules) };
}

export function nightsOf(range: DateRange): number {
  return range.start && range.end ? diffDays(range.start, range.end) : 0;
}

/** setN — הסטפר משנה רק את היציאה: start + n. מינימום 1, מקסימום maxNights אם הוגדר. */
export function setNightsRange(range: DateRange, n: number, rules: RangeRules = DEFAULT_RULES): DateRange {
  if (!range.start) return range;
  const clamped = Math.min(Math.max(n, MIN_NIGHTS), rules.maxNights ?? Number.POSITIVE_INFINITY);
  const end = resolveEnd(range.start, addDays(range.start, clamped), rules);
  return end ? { start: range.start, end } : range;
}

/** effEnd — היציאה, או ה-hover (רק אם מאוחר מההגעה) לתצוגה מקדימה. */
export function effectiveEnd(
  range: DateRange,
  hover: DateKey | null,
  rules: RangeRules = DEFAULT_RULES,
): DateKey | null {
  if (range.end) return range.end;
  if (range.start && hover && hover > range.start) return resolveEnd(range.start, hover, rules);
  return null;
}

// ---------- build: מודל התאים של חודש ----------

/** in = בתוך הטווח · bs = תא ההתחלה · be = תא הסיום · 'bs be' = טווח של יום אחד (שקוף) */
export type CellBand = '' | 'in' | 'bs' | 'be' | 'bs be';
/** sel = הגעה/יציאה נבחרות · prev = יציאה בתצוגה מקדימה · today = היום */
export type CellState = '' | 'sel' | 'prev' | 'today';

export interface DayCell {
  /** null = תא ריק לפני תחילת החודש / אחרי סופו */
  key: DateKey | null;
  day: number;
  band: CellBand;
  state: CellState;
  disabled: boolean;
  /** "4 באוקטובר 2026" — ל-aria-label */
  label: string;
}

export interface MonthModel extends YearMonth {
  title: string;
  rows: number;
  cells: DayCell[];
}

export interface BuildContext {
  range: DateRange;
  effEnd: DateKey | null;
  today: DateKey;
  rules: RangeRules;
}

const EMPTY_CELL: DayCell = { key: null, day: 0, band: '', state: '', disabled: true, label: '' };

export function buildCell(k: DateKey, day: number, ctx: BuildContext): DayCell {
  const { range, effEnd, today, rules } = ctx;
  const isS = k === range.start;
  const isE = k === effEnd;
  const inRange = !!range.start && !!effEnd && k > range.start && k < effEnd;

  let band: CellBand = '';
  if (inRange) band = 'in';
  else if (effEnd) {
    if (isS && isE) band = 'bs be';
    else if (isS) band = 'bs';
    else if (isE) band = 'be';
  }

  let state: CellState = '';
  if (isS || (isE && range.end)) state = 'sel';
  else if (isE) state = 'prev';
  else if (k === today) state = 'today';

  return {
    key: k,
    day,
    band,
    state,
    disabled: !isDateSelectable(k, rules),
    label: formatLong(k, true),
  };
}

/**
 * build(months, uniform) — uniform=true בדסקטופ: שני החודשים מקבלים את מספר השורות
 * המקסימלי מבין השניים כדי שהשורות יהיו מיושרות. במובייל לכל חודש מספר השורות שלו.
 */
export function buildMonths(months: YearMonth[], uniform: boolean, ctx: BuildContext): MonthModel[] {
  const rowsMax = Math.max(...months.map((o) => monthRows(o.y, o.m)));
  return months.map(({ y, m }) => {
    const first = firstWeekday(y, m);
    const dim = daysInMonth(y, m);
    const rows = uniform ? rowsMax : monthRows(y, m);
    const cells: DayCell[] = [];
    for (let n = 0; n < rows * 7; n++) {
      const d = n - first + 1;
      if (d < 1 || d > dim) {
        cells.push(EMPTY_CELL);
        continue;
      }
      cells.push(buildCell(key(y, m, d), d, ctx));
    }
    return { y, m, title: monthTitle(y, m), rows, cells };
  });
}

/** רצף של count חודשים החל מ-base */
export function monthSequence(base: YearMonth, count: number): YearMonth[] {
  return Array.from({ length: count }, (_, i) => {
    let y = base.y;
    let m = base.m + i;
    while (m > 11) {
      m -= 12;
      y++;
    }
    return { y, m };
  });
}

// ---------- ה-hook ----------

export interface UseRangeSelectionOptions {
  value: DateRange;
  onChange: (r: DateRange) => void;
  minDate?: string;
  maxDate?: string;
  /** אופציונלי: בלי ערך — [+] לא נעול לעולם */
  maxNights?: number;
  isDateDisabled?: (d: string) => boolean;
}

export interface RangeSelection {
  start: DateKey | null;
  end: DateKey | null;
  hover: DateKey | null;
  effEnd: DateKey | null;
  nights: number;
  rules: RangeRules;
  canCommit: boolean;
  canDec: boolean;
  canInc: boolean;
  pick: (k: DateKey) => void;
  setHover: (k: DateKey | null) => void;
  /** end = start + n (מינימום 1, maxNights אם הוגדר, קטיעה בחסימה). עובד גם עם הגעה בלבד. */
  setNights: (n: number) => void;
  /** בפתיחה: שומר את הטווח הנוכחי כ-base לשחזור */
  snapshot: () => void;
  /** "סגור": הטווח הנוכחי הופך ל-base. מחזיר אותו. */
  commit: () => DateRange;
  /** ביטול / X / רקע / Esc: משחזר את base (דרך onChange) ומחזיר אותו. */
  cancel: () => DateRange;
  isSelectable: (k: DateKey) => boolean;
}

export function useRangeSelection(opts: UseRangeSelectionOptions): RangeSelection {
  const { value, onChange, minDate, maxDate, maxNights, isDateDisabled } = opts;

  const rules = useMemo<RangeRules>(
    () => ({ minDate, maxDate, maxNights, isDateDisabled }),
    [minDate, maxDate, maxNights, isDateDisabled],
  );

  const [hover, setHoverState] = useState<DateKey | null>(null);
  const baseRef = useRef<DateRange>(value);
  const valueRef = useRef<DateRange>(value);
  valueRef.current = value;

  const effEnd = useMemo(() => effectiveEnd(value, hover, rules), [value, hover, rules]);
  const nights = nightsOf(value);

  const pick = useCallback(
    (k: DateKey) => {
      const cur = valueRef.current;
      if (!isDateSelectable(k, rules)) return;
      setHoverState(null);
      onChange(pickRange(cur, k, rules));
    },
    [onChange, rules],
  );

  const setHover = useCallback(
    (k: DateKey | null) => {
      if (k === null) {
        setHoverState((h) => (h === null ? h : null));
        return;
      }
      const cur = valueRef.current;
      if (cur.start && !cur.end && !isDateBlocked(k, rules)) {
        setHoverState((h) => (h === k ? h : k));
      }
    },
    [rules],
  );

  const setNights = useCallback(
    (n: number) => {
      const cur = valueRef.current;
      // כמו setN בדמו: מספיק תאריך הגעה. בלי הגעה אין על מה לבנות.
      if (!cur.start) return;
      const next = setNightsRange(cur, n, rules);
      if (next.end !== cur.end) {
        setHoverState(null);
        onChange(next);
      }
    },
    [onChange, rules],
  );

  const snapshot = useCallback(() => {
    baseRef.current = valueRef.current;
    setHoverState(null);
  }, []);

  const commit = useCallback(() => {
    baseRef.current = valueRef.current;
    setHoverState(null);
    return baseRef.current;
  }, []);

  const cancel = useCallback(() => {
    const base = baseRef.current;
    const cur = valueRef.current;
    setHoverState(null);
    if (cur.start !== base.start || cur.end !== base.end) onChange(base);
    return base;
  }, [onChange]);

  const isSelectable = useCallback((k: DateKey) => isDateSelectable(k, rules), [rules]);

  const hasEnd = !!value.start && !!value.end;
  const canCommit = hasEnd;
  const canDec = hasEnd && nights > MIN_NIGHTS;
  const canInc =
    hasEnd &&
    (maxNights === undefined || nights < maxNights) &&
    !isDateBlocked(value.end as DateKey, rules) &&
    !(maxDate !== undefined && addDays(value.end as DateKey, 1) > maxDate);

  return {
    start: value.start,
    end: value.end,
    hover,
    effEnd,
    nights,
    rules,
    canCommit,
    canDec,
    canInc,
    pick,
    setHover,
    setNights,
    snapshot,
    commit,
    cancel,
    isSelectable,
  };
}

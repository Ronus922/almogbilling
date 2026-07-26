import { describe, it, expect } from 'vitest';
import {
  computeOccurrences,
  nextOccurrenceAfter,
  parseDateOnly,
  formatDateOnly,
  MAX_OCCURRENCES,
  type RecurrenceRule,
} from '@/lib/recurrence/engine';

const rule = (over: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: 'weekly',
  interval: 1,
  byweekday: null,
  endType: 'never',
  endDate: null,
  endCount: null,
  ...over,
});

/** Run the engine with 'YYYY-MM-DD' inputs and get 'YYYY-MM-DD' back. */
function occ(
  r: RecurrenceRule,
  anchor: string,
  horizon: string,
  excluded: string[] = [],
): string[] {
  const a = parseDateOnly(anchor)!;
  const h = parseDateOnly(horizon)!;
  return computeOccurrences(r, a, h, new Set(excluded)).map(formatDateOnly);
}

describe('computeOccurrences', () => {
  // 2026-06-14 is a Sunday (weekday 0).

  it('daily, never-end, clamps to the horizon (inclusive both ends)', () => {
    expect(occ(rule({ frequency: 'daily' }), '2026-06-14', '2026-06-18')).toEqual([
      '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18',
    ]);
  });

  it('weekly with multiple byweekday (Sun+Wed), after_count caps total', () => {
    const r = rule({ frequency: 'weekly', byweekday: [0, 3], endType: 'after_count', endCount: 4 });
    expect(occ(r, '2026-06-14', '2026-12-31')).toEqual([
      '2026-06-14', // Sun (anchor)
      '2026-06-17', // Wed
      '2026-06-21', // Sun
      '2026-06-24', // Wed
    ]);
  });

  it('weekly with interval=2 only fires every other week', () => {
    const r = rule({ frequency: 'weekly', byweekday: [1], interval: 2, endType: 'after_count', endCount: 3 });
    expect(occ(r, '2026-06-14', '2026-12-31')).toEqual([
      '2026-06-15', // Mon (week 0)
      '2026-06-29', // Mon (week 2)
      '2026-07-13', // Mon (week 4)
    ]);
  });

  it('weekly skips byweekday days that fall before the anchor in its first week', () => {
    // anchor Wed 2026-06-17, byweekday Mon+Wed → the Monday of the anchor week is skipped.
    const r = rule({ frequency: 'weekly', byweekday: [1, 3], endType: 'after_count', endCount: 3 });
    expect(occ(r, '2026-06-17', '2026-12-31')).toEqual([
      '2026-06-17', // Wed (anchor)
      '2026-06-22', // Mon (next week)
      '2026-06-24', // Wed (next week)
    ]);
  });

  it('end_type=after_count yields exactly endCount occurrences', () => {
    const r = rule({ frequency: 'weekly', endType: 'after_count', endCount: 5 });
    expect(occ(r, '2026-06-14', '2027-12-31')).toEqual([
      '2026-06-14', '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12',
    ]);
  });

  it('end_type=on_date stops on/at the end date (inclusive)', () => {
    const r = rule({ frequency: 'daily', endType: 'on_date', endDate: '2026-06-17' });
    expect(occ(r, '2026-06-14', '2026-06-30')).toEqual([
      '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17',
    ]);
  });

  it('on_date is also clamped by an earlier horizon', () => {
    const r = rule({ frequency: 'daily', endType: 'on_date', endDate: '2026-12-31' });
    expect(occ(r, '2026-06-14', '2026-06-16')).toEqual([
      '2026-06-14', '2026-06-15', '2026-06-16',
    ]);
  });

  it('skips dates listed in exceptions, and the skipped date still consumed the count', () => {
    const r = rule({ frequency: 'daily', endType: 'after_count', endCount: 4 });
    // raw = 14,15,16,17 (count 4); exclude 15 → 14,16,17 (NOT back-filled to a 5th).
    expect(occ(r, '2026-06-14', '2026-06-30', ['2026-06-15'])).toEqual([
      '2026-06-14', '2026-06-16', '2026-06-17',
    ]);
  });

  it('monthly anchors on day-of-month and clamps short months (Jan 31 → Feb 28)', () => {
    const r = rule({ frequency: 'monthly', endType: 'after_count', endCount: 3 });
    expect(occ(r, '2026-01-31', '2026-12-31')).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31',
    ]);
  });

  it('yearly steps a full year and clamps Feb 29 on non-leap years', () => {
    const r = rule({ frequency: 'yearly', endType: 'after_count', endCount: 2 });
    expect(occ(r, '2028-02-29', '2031-12-31')).toEqual([
      '2028-02-29', '2029-02-28', // 2029 is not a leap year
    ]);
  });

  it('returns nothing when the horizon is before the anchor', () => {
    expect(occ(rule({ frequency: 'daily' }), '2026-06-14', '2026-06-13')).toEqual([]);
  });

  it('never-end with a far horizon is capped at MAX_OCCURRENCES', () => {
    const r = rule({ frequency: 'daily' });
    const dates = occ(r, '2020-01-01', '2030-01-01');
    expect(dates.length).toBe(MAX_OCCURRENCES);
  });
});

/** fromDate raises the lower bound WITHOUT re-anchoring the step arithmetic. */
describe('computeOccurrences — fromDate fast-forward', () => {
  function from(r: RecurrenceRule, anchor: string, horizon: string, lower: string): string[] {
    return computeOccurrences(
      r, parseDateOnly(anchor)!, parseDateOnly(horizon)!, new Set(), parseDateOnly(lower)!,
    ).map(formatDateOnly);
  }

  it('reaches dates far past MAX_OCCURRENCES from the anchor', () => {
    // Anchored 6 years back: without the fast-forward the 366-occurrence cap
    // would be spent long before 2026 and the result would be empty.
    const r = rule({ frequency: 'daily' });
    expect(from(r, '2020-01-01', '2026-06-16', '2026-06-14')).toEqual([
      '2026-06-14', '2026-06-15', '2026-06-16',
    ]);
  });

  it('preserves the interval phase rather than re-anchoring on fromDate', () => {
    // Every 3 days from 2026-06-14 → 14, 17, 20, 23... A naive re-anchor onto
    // 2026-06-19 would wrongly emit 19, 22, 25.
    const r = rule({ frequency: 'daily', interval: 3 });
    expect(from(r, '2026-06-14', '2026-06-27', '2026-06-19')).toEqual([
      '2026-06-20', '2026-06-23', '2026-06-26',
    ]);
  });

  it('preserves the weekly interval phase across the fast-forward', () => {
    // Mondays every other week from 2026-06-14 → 06-15, 06-29, 07-13, 07-27.
    const r = rule({ frequency: 'weekly', byweekday: [1], interval: 2 });
    expect(from(r, '2026-06-14', '2026-08-01', '2026-07-01')).toEqual([
      '2026-07-13', '2026-07-27',
    ]);
  });

  it('does not drift the monthly day-of-month through a short month', () => {
    // The 31st, fast-forwarded past February: the anchor day must still be 31,
    // not the clamped 28 from re-anchoring on Feb.
    const r = rule({ frequency: 'monthly' });
    expect(from(r, '2026-01-31', '2026-05-31', '2026-03-01')).toEqual([
      '2026-03-31', '2026-04-30', '2026-05-31',
    ]);
  });

  it('is ignored for after_count, which must count from the anchor', () => {
    const r = rule({ frequency: 'daily', endType: 'after_count', endCount: 3 });
    expect(from(r, '2026-06-14', '2026-06-30', '2026-06-20')).toEqual([
      '2026-06-14', '2026-06-15', '2026-06-16',
    ]);
  });
});

describe('nextOccurrenceAfter', () => {
  const next = (r: RecurrenceRule, anchor: string, after: string, excluded: string[] = []) =>
    nextOccurrenceAfter(r, parseDateOnly(anchor)!, parseDateOnly(after)!, new Set(excluded));

  it('returns the following occurrence, never the one passed in', () => {
    const r = rule({ frequency: 'weekly', byweekday: [0, 3] });
    expect(next(r, '2026-06-14', '2026-06-14')).toBe('2026-06-17');
    expect(next(r, '2026-06-14', '2026-06-17')).toBe('2026-06-21');
  });

  it('advances a series whose anchor is years in the past', () => {
    expect(next(rule({ frequency: 'daily' }), '2020-01-01', '2026-06-14')).toBe('2026-06-15');
  });

  it('jumps over excluded dates', () => {
    const r = rule({ frequency: 'daily' });
    expect(next(r, '2026-06-14', '2026-06-14', ['2026-06-15', '2026-06-16'])).toBe('2026-06-17');
  });

  it('crosses a yearly gap', () => {
    expect(next(rule({ frequency: 'yearly' }), '2026-09-01', '2026-09-01')).toBe('2027-09-01');
  });

  it('returns null once after_count is exhausted', () => {
    const r = rule({ frequency: 'daily', endType: 'after_count', endCount: 3 });
    expect(next(r, '2026-06-14', '2026-06-15')).toBe('2026-06-16');
    expect(next(r, '2026-06-14', '2026-06-16')).toBeNull();
  });

  it('returns null once the end date has passed', () => {
    const r = rule({ frequency: 'daily', endType: 'on_date', endDate: '2026-06-16' });
    expect(next(r, '2026-06-14', '2026-06-16')).toBeNull();
  });
});

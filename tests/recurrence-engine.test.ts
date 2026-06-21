import { describe, it, expect } from 'vitest';
import {
  computeOccurrences,
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

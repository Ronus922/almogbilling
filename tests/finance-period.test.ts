import { describe, expect, it } from 'vitest';
import { isIsoDate, isMonthKey, monthKeyOf, monthLabel, parseMonthParam, periodMonthOf, shiftMonthKey, monthFolderParts } from '@/lib/finance/period';

describe('finance period helpers', () => {
  it('validates month keys and iso dates', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-9')).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
    expect(isIsoDate('2026-09-15')).toBe(true);
    expect(isIsoDate('2026-09-32')).toBe(false);
    expect(isIsoDate('15/09/2026')).toBe(false);
  });

  it('derives the month and the period from a date', () => {
    expect(monthKeyOf('2026-09-15')).toBe('2026-09');
    expect(periodMonthOf('2026-09')).toBe('2026-09-01');
    expect(monthFolderParts('2026-09-15')).toEqual({ year: '2026', month: '09' });
    expect(monthFolderParts('2026-09')).toEqual({ year: '2026', month: '09' });
  });

  it('shifts months across year boundaries', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(shiftMonthKey('2026-09', -18)).toBe('2025-03');
    expect(shiftMonthKey('2026-09', 0)).toBe('2026-09');
  });

  it('labels a month in Hebrew', () => {
    expect(monthLabel('2026-09')).toBe('ספטמבר 2026');
    expect(monthLabel('2026-01')).toBe('ינואר 2026');
  });

  it('falls back to the current month on a bad ?m=', () => {
    expect(parseMonthParam('2026-03')).toBe('2026-03');
    expect(parseMonthParam(['2026-03'])).toBe('2026-03');
    expect(isMonthKey(parseMonthParam('nope'))).toBe(true);
    expect(isMonthKey(parseMonthParam(undefined))).toBe(true);
  });
});

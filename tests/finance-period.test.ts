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

// ── Periods (the overview's date picker): month · quarter · half · year ──────
import { HALF_LABEL, makePeriod, parsePeriod, parsePeriodParam, periodLabel, periodMonthKeys, monthKeyParts } from '@/lib/finance/period';

describe('finance periods', () => {
  it('parses the four URL forms and rejects the rest', () => {
    expect(parsePeriod('2026-09')).toMatchObject({ kind: 'month', year: 2026, index: 9, from: '2026-09', to: '2026-09', key: '2026-09' });
    expect(parsePeriod('2026-Q3')).toMatchObject({ kind: 'quarter', year: 2026, index: 3, from: '2026-07', to: '2026-09', key: '2026-Q3' });
    expect(parsePeriod('2026-H2')).toMatchObject({ kind: 'half', year: 2026, index: 2, from: '2026-07', to: '2026-12', key: '2026-H2' });
    expect(parsePeriod('2026')).toMatchObject({ kind: 'year', year: 2026, index: 1, from: '2026-01', to: '2026-12', key: '2026' });
    expect(parsePeriod('2026-Q5')).toBeNull();
    expect(parsePeriod('2026-H3')).toBeNull();
    expect(parsePeriod('2026-13')).toBeNull();
    expect(parsePeriod('nope')).toBeNull();
    expect(parsePeriod(undefined)).toBeNull();
  });

  it('builds ranges from kind + year + index', () => {
    expect(makePeriod('quarter', 2026, 1)).toMatchObject({ from: '2026-01', to: '2026-03' });
    expect(makePeriod('quarter', 2026, 4)).toMatchObject({ from: '2026-10', to: '2026-12' });
    expect(makePeriod('half', 2026, 1)).toMatchObject({ from: '2026-01', to: '2026-06' });
    expect(periodMonthKeys(makePeriod('quarter', 2026, 3))).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(periodMonthKeys(makePeriod('year', 2026, 1))).toHaveLength(12);
    expect(periodMonthKeys(makePeriod('month', 2026, 2))).toEqual(['2026-02']);
    expect(monthKeyParts('2026-09')).toEqual({ year: 2026, month: 9 });
  });

  it('labels periods in Hebrew', () => {
    expect(periodLabel(makePeriod('month', 2026, 9))).toBe('ספטמבר 2026');
    expect(periodLabel(makePeriod('quarter', 2026, 3))).toBe('רבעון 3 · 2026');
    expect(periodLabel(makePeriod('half', 2026, 2))).toBe(`${HALF_LABEL[2]} · 2026`);
    expect(periodLabel(makePeriod('year', 2026, 1))).toBe('כל 2026');
  });

  it('falls back to the current month on a bad ?m=', () => {
    expect(parsePeriodParam('2026-Q2').key).toBe('2026-Q2');
    expect(parsePeriodParam(['2026-H1']).key).toBe('2026-H1');
    expect(parsePeriodParam('garbage').kind).toBe('month');
    expect(parsePeriodParam(undefined).kind).toBe('month');
  });
});

import { describe, expect, it } from 'vitest';
import {
  apartmentsLabel, axisLabel, categoriesOf, categoryShares, firstName, flatEntries, fmtEntryDate, fmtIls, initials,
  monthShort, monthsByYear, niceAxis, parseOverviewSpan, parsePortalTab, parseTxFilter, pctVsAverage, reportRangeFor,
  reportRanges, windowKeys,
} from '@/lib/portal/ui';
import type { ResidentEntry } from '@/lib/types/finance';

// The pure helpers behind the owners-portal screens (src/lib/portal/ui.ts):
// the URL vocabulary, the reference's formats, the selectors' rules (only
// published months, grouped by year, newest first) and the overview
// arithmetic. No DB, no React.

const entry = (over: Partial<ResidentEntry>): ResidentEntry => ({
  kind: 'expense', section: 'operating', category_name: 'ניקיון', description: 'x', amount: 100,
  payment_date: '2026-09-15', period_month: '2026-09-01', ...over,
});

describe('portal tabs in the URL', () => {
  it('reads a known tab, maps the old operating tab, defaults to the overview', () => {
    expect(parsePortalTab('tx', undefined)).toBe('tx');
    expect(parsePortalTab('fund', undefined)).toBe('fund');
    expect(parsePortalTab('operating', undefined)).toBe('tx');
    expect(parsePortalTab(undefined, undefined)).toBe('ov');
    expect(parsePortalTab('nope', undefined)).toBe('ov');
  });
  it('an old range link (?m=2026-Q3) lands on the reports tab; a month does not', () => {
    expect(parsePortalTab(undefined, '2026-Q3')).toBe('rep');
    expect(parsePortalTab(undefined, '2026')).toBe('rep');
    expect(parsePortalTab(undefined, '2026-09')).toBe('ov');
  });
  it('span and filter fall back safely', () => {
    expect(parseOverviewSpan('6')).toBe(6);
    expect(parseOverviewSpan('7')).toBe(12);
    expect(parseTxFilter('in')).toBe('in');
    expect(parseTxFilter('x')).toBe('all');
  });
});

describe("the reference's formats", () => {
  it('₪ with en-US grouping, no space, absolute value, agorot kept', () => {
    expect(fmtIls(8820)).toBe('₪8,820');
    expect(fmtIls(-1240)).toBe('₪1,240');
    expect(fmtIls(1234.5)).toBe('₪1,234.5');
    expect(fmtIls(0)).toBe('₪0');
  });
  it('an expense shows its full date, an income only its month', () => {
    expect(fmtEntryDate(entry({ kind: 'expense', payment_date: '2026-09-05' }))).toBe('05.09.2026');
    expect(fmtEntryDate(entry({ kind: 'income', payment_date: null, period_month: '2026-09-01' }))).toBe('09.2026');
  });
  it('short month labels and names', () => {
    expect(monthShort('2026-09')).toBe('ספט׳');
    expect(monthShort('2026-03')).toBe('מרץ');
  });
  it('greeting and avatar', () => {
    expect(firstName('דנה לוי')).toBe('דנה');
    expect(firstName('  ')).toBeNull();
    expect(initials('דנה לוי')).toBe('ד״ל');
    expect(initials('דנה')).toBe('ד');
    expect(initials(null)).toBe('ב״ד');
    expect(apartmentsLabel(['7'])).toBe('דירה 7');
    expect(apartmentsLabel(['1210', '520'])).toBe('דירות 1210, 520');
  });
});

describe('selectors — published months only, grouped by year, newest first', () => {
  const published = ['2025-11', '2026-01', '2026-02', '2026-07'];
  it('groups months by year, newest year and newest month first', () => {
    expect(monthsByYear(published)).toEqual([
      { year: '2026', months: ['2026-07', '2026-02', '2026-01'] },
      { year: '2025', months: ['2025-11'] },
    ]);
  });
  it('lists only ranges that hold a published month', () => {
    const keys = reportRanges(published).map((p) => p.key);
    expect(keys).toEqual(['2026', '2026-H2', '2026-H1', '2026-Q3', '2026-Q1', '2025', '2025-H2', '2025-Q4']);
  });
  it('keeps a requested range in the list, else the newest one, null when nothing is published', () => {
    const ranges = reportRanges(published);
    expect(reportRangeFor('2026-Q1', ranges)?.key).toBe('2026-Q1');
    expect(reportRangeFor('2026-Q2', ranges)?.key).toBe('2026');
    expect(reportRangeFor('2026-07', ranges)?.key).toBe('2026');
    expect(reportRangeFor(undefined, [])).toBeNull();
  });
});

describe('overview arithmetic', () => {
  it('window keys run up to the newest month', () => {
    expect(windowKeys('2026-09', 3)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(windowKeys('2026-01', 2)).toEqual(['2025-12', '2026-01']);
  });
  it('percent against the period average, null with nothing to compare', () => {
    expect(pctVsAverage(92, [100, 100, 100, 92])).toBe(-6);
    expect(pctVsAverage(110, [100, 100])).toBe(10);
    expect(pctVsAverage(5, [])).toBeNull();
    expect(pctVsAverage(5, [0, 0])).toBeNull();
    expect(pctVsAverage(7, [7])).toBe(0);
  });
  it('a nice axis with four steps that covers the maximum', () => {
    expect(niceAxis(13480)).toEqual({ max: 20000, step: 5000 });
    expect(niceAxis(376312)).toEqual({ max: 400000, step: 100000 });
    expect(niceAxis(0)).toEqual({ max: 4, step: 1 });
    expect(axisLabel(0)).toBe('0');
    expect(axisLabel(3500)).toBe('3.5K');
    expect(axisLabel(100000)).toBe('100K');
    expect(axisLabel(1200000)).toBe('1.2M');
    expect(axisLabel(500)).toBe('500');
  });
  it('category shares: largest first, share of total, width against the largest, zeros dropped', () => {
    const s = categoryShares([{ name: 'a', total: 100 }, { name: 'b', total: 300 }, { name: 'c', total: 0 }]);
    expect(s.map((c) => c.name)).toEqual(['b', 'a']);
    expect(s[0]).toMatchObject({ pct: 75, bar: 100 });
    expect(s[1]).toMatchObject({ pct: 25, bar: (100 / 300) * 100 });
  });
  it('categoriesOf sums one kind of a month', () => {
    const rows = [
      entry({ category_name: 'ניקיון', amount: 100 }),
      entry({ category_name: 'ניקיון', amount: 50 }),
      entry({ category_name: 'גינון', amount: 500 }),
      entry({ kind: 'income', category_name: 'דמי ועד', amount: 9000, payment_date: null }),
    ];
    expect(categoriesOf(rows, 'expense').map((c) => [c.name, c.total])).toEqual([['גינון', 500], ['ניקיון', 150]]);
    expect(categoriesOf(rows, 'income').map((c) => [c.name, c.total])).toEqual([['דמי ועד', 9000]]);
  });
  it('flatEntries filters by kind and sorts newest first', () => {
    const rows = [
      entry({ description: 'old', payment_date: '2026-09-02' }),
      entry({ kind: 'income', description: 'inc', payment_date: null, period_month: '2026-09-01' }),
      entry({ description: 'new', payment_date: '2026-09-20' }),
    ];
    expect(flatEntries(rows, 'all').map((e) => e.description)).toEqual(['new', 'old', 'inc']);
    expect(flatEntries(rows, 'in').map((e) => e.description)).toEqual(['inc']);
    expect(flatEntries(rows, 'out').map((e) => e.description)).toEqual(['new', 'old']);
  });
});

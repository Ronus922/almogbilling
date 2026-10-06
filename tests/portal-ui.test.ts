import { describe, expect, it } from 'vitest';
import {
  accountTotals, apartmentsLabel, axisLabel, categoriesOf, categoryShares, firstName, flatEntries, fmtDateDMY, fmtDelta,
  fmtEntryDate, fmtIls, fmtSigned, initials, monthShort, niceAxis, parseOverviewSpan, parsePortalTab,
  parseTxFilter, pctVsAverage, reportRangeFor, reportRanges, roundShekels, sanitizeCell,
  signClass, spansYears, sumExact, trendMonthLabel, windowKeys,
} from '@/lib/portal/ui';
import { AMOUNT_NUM_FMT, buildPortalPeriodWorkbook } from '@/lib/portal/export';
import {
  formatSupportPhone, hasPortalSupport, joinRequestSubject, supportMailtoHref, supportTelHref,
} from '@/lib/portal/support';
import { PORTAL_NOT_OWNER_MESSAGE, pointsAtManagementCompany, portalLockedMessage } from '@/lib/constants/portal';
import { makePeriod } from '@/lib/finance/period';
import { rangeHasPublished } from '@/lib/finance/resident';
import type { PortalAccount } from '@/lib/types/portal';
import type { ResidentEntry } from '@/lib/types/finance';

// The pure helpers behind the owners-portal screens (src/lib/portal/ui.ts):
// the URL vocabulary, the reference's formats, the selectors' rules (only
// published months, grouped by year, newest first) and the overview
// arithmetic. No DB, no React.

const entry = (over: Partial<ResidentEntry>): ResidentEntry => ({
  kind: 'expense', section: 'operating', category_id: 'cat-cleaning', category_name: 'ניקיון', description: 'x', amount: 100,
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
  // The period picker writes `?m=` in all four grammars; a link that carries
  // only a period — the ones the pre-PR#44 portal produced — opens the
  // transactions tab on it, which is where it used to land (29/09/2026).
  it('a period in ?m= opens the transactions tab, whichever of the four it is', () => {
    expect(parsePortalTab(undefined, '2026-09')).toBe('tx');
    expect(parsePortalTab(undefined, '2026-Q3')).toBe('tx');
    expect(parsePortalTab(undefined, '2026-H1')).toBe('tx');
    expect(parsePortalTab(undefined, '2026')).toBe('tx');
    expect(parsePortalTab(undefined, 'garbage')).toBe('ov');
    // an explicit tab still wins over the period
    expect(parsePortalTab('rep', '2026-Q3')).toBe('rep');
  });
  it('span and filter fall back safely', () => {
    expect(parseOverviewSpan('6')).toBe(6);
    expect(parseOverviewSpan('7')).toBe(12);
    expect(parseTxFilter('in')).toBe('in');
    expect(parseTxFilter('x')).toBe('all');
  });
});

describe("the reference's formats", () => {
  it('₪ with en-US grouping, no space, absolute value, whole shekels', () => {
    expect(fmtIls(8820)).toBe('₪8,820');
    expect(fmtIls(-1240)).toBe('₪1,240');
    expect(fmtIls(1234.5)).toBe('₪1,235');
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

  // What the ONE-CLICK picker (components/finance/PeriodPicker, residentMode)
  // asks of every cell it draws: a month must be published, and a quarter /
  // half / year must hold one. Pinned here because it is the rule that keeps a
  // hidden month out of the resident's reach.
  it('a resident may open a published month, and no other', () => {
    const set = new Set(published);
    expect(set.has('2026-07')).toBe(true);
    expect(set.has('2026-03')).toBe(false);
  });
  it('a resident may open a range only when it holds a published month', () => {
    const set = new Set(published);
    expect(rangeHasPublished('2026-07', '2026-09', set)).toBe(true);  // Q3 holds 07
    expect(rangeHasPublished('2026-04', '2026-06', set)).toBe(false); // Q2 holds none
    expect(rangeHasPublished('2026-01', '2026-12', set)).toBe(true);  // the year
    expect(rangeHasPublished('2024-01', '2024-12', set)).toBe(false);
    expect(rangeHasPublished('2026-01', '2026-12', new Set())).toBe(false);
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
      entry({ category_id: 'cat-garden', category_name: 'גינון', amount: 500 }),
      entry({ kind: 'income', category_id: 'cat-fees', category_name: 'דמי ועד', amount: 9000, payment_date: null }),
    ];
    expect(categoriesOf(rows, 'expense').map((c) => [c.name, c.total])).toEqual([['גינון', 500], ['ניקיון', 150]]);
    expect(categoriesOf(rows, 'income').map((c) => [c.name, c.total])).toEqual([['דמי ועד', 9000]]);
  });
  // The transactions tab's row asks its trend by the category id (06/10/2026),
  // so the grouping carries it — and an extra field rides through the shares.
  it('categoriesOf keys a category by its id and hands the id to the row', () => {
    const rows = [
      entry({ category_id: 'cat-a', category_name: 'חשמל', amount: 120.4 }),
      entry({ category_id: 'cat-a', category_name: 'חשמל', amount: 79.6 }),
      entry({ category_id: 'cat-b', category_name: 'מים', amount: 50 }),
    ];
    expect(categoriesOf(rows, 'expense').map((c) => [c.id, c.name, c.total])).toEqual([['cat-a', 'חשמל', 200], ['cat-b', 'מים', 50]]);
    expect(categoryShares([{ id: 'x', name: 'a', total: 10 }])[0]).toEqual({ id: 'x', name: 'a', total: 10, pct: 100, bar: 100 });
  });
  it('the trend labels: a short month, with two year digits once the window spans years', () => {
    expect(trendMonthLabel('2025-12', false)).toBe('דצמ׳');
    expect(trendMonthLabel('2025-12', true)).toBe('דצמ׳ 25');
    expect(trendMonthLabel('2026-01', true)).toBe('ינו׳ 26');
    expect(spansYears(['2026-01', '2026-09'])).toBe(false);
    expect(spansYears(['2025-12', '2026-01'])).toBe(true);
    expect(spansYears([])).toBe(false);
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

describe('my account + Excel safety (28/09/2026)', () => {
  const acc = (o: Partial<PortalAccount>): PortalAccount => ({
    apartment_number: '7', role: 'owner', owner_display_name: null, total_debt: 0, management_fees: 0, hot_water_debt: 0,
    monthly_debt: null, details: null, synced_at: null, ...o,
  });
  it('sums every record of the owner exactly — the card rounds, the sum does not', () => {
    const t = accountTotals([
      acc({ total_debt: 1240.6, management_fees: 840.6, hot_water_debt: 400 }),
      acc({ apartment_number: '8', total_debt: 300.5, hot_water_debt: 300.5 }),
    ]);
    expect(t).toEqual({ total: 1541.1, management: 840.6, hotWater: 700.5 });
    expect(fmtIls(t.total)).toBe('₪1,541');
    expect(accountTotals([])).toEqual({ total: 0, management: 0, hotWater: 0 });
  });
  it('formats the "as of" date in Israel time and the bank delta with its sign', () => {
    expect(fmtDateDMY('2026-09-28T02:30:23.953Z')).toBe('28.09.2026');
    expect(fmtDateDMY('2026-09-27T21:30:00Z')).toBe('28.09.2026');
    expect(fmtDateDMY(null)).toBeNull();
    expect(fmtDateDMY('not a date')).toBeNull();
    expect(fmtDelta(2140)).toBe('+₪2,140');
    expect(fmtDelta(-2140)).toBe('−₪2,140');
    expect(fmtDelta(0)).toBe('₪0');
    // the sign is decided after rounding: a delta under half a shekel is ₪0
    expect(fmtDelta(0.3)).toBe('₪0');
    expect(fmtDelta(-0.49)).toBe('₪0');
    expect(fmtDelta(0.5)).toBe('+₪1');
  });
  it('neutralises a cell a spreadsheet would run as a formula', () => {
    expect(sanitizeCell('=1+1')).toBe("'=1+1");
    expect(sanitizeCell('+972')).toBe("'+972");
    expect(sanitizeCell('-5')).toBe("'-5");
    expect(sanitizeCell('@SUM')).toBe("'@SUM");
    expect(sanitizeCell('\tx')).toBe("'\tx");
    expect(sanitizeCell('ניקיון')).toBe('ניקיון');
    expect(sanitizeCell('')).toBe('');
  });
});

describe('whole shekels on the screen, agorot in the file (28/09/2026)', () => {
  it('rounds half up on the agorot, away from zero for a negative figure', () => {
    expect(roundShekels(1240.6)).toBe(1241);
    expect(roundShekels(1240.5)).toBe(1241);
    expect(roundShekels(1240.49)).toBe(1240);
    expect(roundShekels(0.5)).toBe(1);
    expect(roundShekels(2.5)).toBe(3);
    expect(roundShekels(0.4999)).toBe(0);
    expect(roundShekels(-2.5)).toBe(-3);
    expect(roundShekels(-1240.49)).toBe(-1240);
    expect(roundShekels(-0.3)).toBe(0);
    expect(Object.is(roundShekels(-0.3), 0)).toBe(true);
    // float noise on a numeric 1,240.50 still rounds up; a real 0.4999 stays 0
    expect(roundShekels(1240.4999999999)).toBe(1241);
    expect(roundShekels(0.1 + 0.2 + 0.2)).toBe(1);
    expect(fmtIls(1240.6)).toBe('₪1,241');
    expect(fmtIls(-1240.5)).toBe('₪1,241');
    expect(fmtIls(999999.5)).toBe('₪1,000,000');
  });
  it('a signed figure shows its sign after rounding, and its colour follows', () => {
    expect(fmtSigned(7020.9)).toBe('₪7,021');
    expect(fmtSigned(-412.4)).toBe('−₪412');
    expect(fmtSigned(-0.3)).toBe('₪0');
    expect(fmtSigned(0)).toBe('₪0');
    expect(signClass(0.6)).toBe('in');
    expect(signClass(-0.6)).toBe('out');
    expect(signClass(0.4)).toBe('');
    expect(signClass(-0.4)).toBe('');
  });
  it('a total is the exact sum, rounded once — not a sum of rounded lines', () => {
    const lines = [1240.6, 0.6, 0.6];
    expect(sumExact(lines)).toBeCloseTo(1241.8, 10);
    expect(fmtIls(sumExact(lines))).toBe('₪1,242');
    expect(lines.map(fmtIls)).toEqual(['₪1,241', '₪1', '₪1']);
    // (₪1,243 by adding the rounded lines — the ₪1 gap is expected)
    expect(fmtIls(lines.map(roundShekels).reduce((s, v) => s + v, 0))).toBe('₪1,243');
    // shares and averages are computed on the exact figures too
    expect(categoryShares([{ name: 'a', total: 0.6 }, { name: 'b', total: 0.6 }, { name: 'c', total: 0.2 }]).map((c) => c.pct)).toEqual([43, 43, 14]);
    expect(pctVsAverage(1.5, [1, 1, 1, 1.5])).toBe(33);
  });
  it('the Excel workbook keeps the agorot as a number formatted with two decimals', async () => {
    const wb = await buildPortalPeriodWorkbook({ period: makePeriod('month', 2026, 8), rows: [
      entry({ kind: 'expense', amount: 1800.5, description: 'ניקיון' }),
      entry({ kind: 'income', amount: 8820.4, description: 'דמי ועד', payment_date: null, period_month: '2026-08-01' }),
    ] });
    const ws = wb.worksheets[0];
    expect(ws.getRow(2).getCell(5).value).toBe(1800.5);
    expect(ws.getRow(3).getCell(5).value).toBe(8820.4);
    expect(ws.getRow(2).getCell(5).numFmt).toBe(AMOUNT_NUM_FMT);
    expect(ws.getRow(3).getCell(5).numFmt).toBe('#,##0.00');
    expect(ws.getRow(2).getCell(4).value).toBe('15.09.2026');
  });
});

describe('the management company details on the lock screens', () => {
  it('formats a landline, a mobile and anything else exactly as configured', () => {
    // Ronen's number, as he asked for it to read on screen.
    expect(formatSupportPhone('048341881')).toBe('04-834-1881');
    expect(formatSupportPhone('04-834-1881')).toBe('04-834-1881');
    expect(formatSupportPhone('+97248341881')).toBe('04-834-1881');
    expect(formatSupportPhone('0525460546')).toBe('052-546-0546');
    // Not an Israeli number — shown as typed rather than mangled into one.
    expect(formatSupportPhone('+1 415 555 2671')).toBe('+1 415 555 2671');
    expect(formatSupportPhone('  ')).toBeNull();
    expect(formatSupportPhone(null)).toBeNull();
  });
  it('dials E.164 so the call connects from abroad too', () => {
    expect(supportTelHref('048341881')).toBe('tel:+97248341881');
    expect(supportTelHref('04-834-1881')).toBe('tel:+97248341881');
    expect(supportTelHref('+1 415 555 2671')).toBe('tel:+14155552671');
    expect(supportTelHref(null)).toBeNull();
  });
  it('knows when there is nothing to offer, so no empty box is drawn', () => {
    expect(hasPortalSupport({ phone: null, email: null })).toBe(false);
    expect(hasPortalSupport({ phone: '  ', email: '' })).toBe(false);
    expect(hasPortalSupport({ phone: null, email: 'a@b.co' })).toBe(true);
    expect(hasPortalSupport({ phone: '048341881', email: null })).toBe(true);
  });
  it('addresses the join request with the number in the subject', () => {
    expect(joinRequestSubject('050-999-9999')).toBe('בקשת הצטרפות לפורטל — 050-999-9999');
    expect(supportMailtoHref('mgmt@example.test', joinRequestSubject('050-999-9999')))
      .toBe(`mailto:mgmt@example.test?subject=${encodeURIComponent('בקשת הצטרפות לפורטל — 050-999-9999')}`);
    // No subject → a plain address; no address → no link at all.
    expect(supportMailtoHref('mgmt@example.test')).toBe('mailto:mgmt@example.test');
    expect(supportMailtoHref(null, 'x')).toBeNull();
  });
  it('spots the copy that sends a resident to the management company', () => {
    expect(pointsAtManagementCompany(PORTAL_NOT_OWNER_MESSAGE)).toBe(true);
    expect(pointsAtManagementCompany(portalLockedMessage(30))).toBe(true);
    expect(pointsAtManagementCompany('שליחת הקוד נכשלה. נסה שוב בעוד רגע, או פנה לחברת הניהול.')).toBe(true);
    // Copy that merely mentions the code is not an invitation to ring anyone.
    expect(pointsAtManagementCompany('הקוד שגוי. נותרו 4 ניסיונות.')).toBe(false);
    expect(pointsAtManagementCompany(null)).toBe(false);
  });
});

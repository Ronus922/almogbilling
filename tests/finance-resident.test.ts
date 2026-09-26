import { describe, expect, it } from 'vitest';
import { periodOpenToResidents, publishedMonthKeys, rangeHasPublished, residentPeriodFor } from '@/lib/finance/resident';
import { makePeriod } from '@/lib/finance/period';

// The resident view lands on published months only (src/lib/finance/resident.ts).
describe('resident view — which period a resident gets', () => {
  const published = ['2026-08', '2026-05', '2026-04'];

  it('turns status rows into newest-first month keys', () => {
    expect(publishedMonthKeys([{ year: 2026, month: 4 }, { year: 2026, month: 8 }, { year: 2025, month: 12 }]))
      .toEqual(['2026-08', '2026-04', '2025-12']);
  });

  it('a month is open only when published; a range when it holds a published month', () => {
    const set = new Set(published);
    expect(periodOpenToResidents(makePeriod('month', 2026, 8), set)).toBe(true);
    expect(periodOpenToResidents(makePeriod('month', 2026, 9), set)).toBe(false);
    expect(periodOpenToResidents(makePeriod('quarter', 2026, 2), set)).toBe(true);   // Apr–Jun holds Apr + May
    expect(periodOpenToResidents(makePeriod('quarter', 2026, 1), set)).toBe(false);  // Jan–Mar: nothing
    expect(periodOpenToResidents(makePeriod('half', 2026, 2), set)).toBe(true);
    expect(periodOpenToResidents(makePeriod('year', 2025, 1), set)).toBe(false);
    expect(rangeHasPublished('2026-06', '2026-07', set)).toBe(false);
  });

  it('keeps a requested period that is open, else falls back to the newest published month', () => {
    expect(residentPeriodFor('2026-05', published)?.key).toBe('2026-05');
    expect(residentPeriodFor('2026-Q2', published)?.key).toBe('2026-Q2');
    expect(residentPeriodFor('2026-09', published)?.key).toBe('2026-08'); // hidden month → newest published
    expect(residentPeriodFor('2026-Q1', published)?.key).toBe('2026-08'); // empty quarter → newest published
    expect(residentPeriodFor(undefined, published)?.key).toBe('2026-08');
    expect(residentPeriodFor(['garbage'], published)?.key).toBe('2026-08');
    expect(residentPeriodFor('2026-08', ['2026-04', '2026-08'])?.key).toBe('2026-08');
  });

  it('nothing published → null (the empty screen)', () => {
    expect(residentPeriodFor('2026-08', [])).toBeNull();
    expect(residentPeriodFor(undefined, [])).toBeNull();
  });
});

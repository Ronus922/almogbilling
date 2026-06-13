import { describe, it, expect } from 'vitest';
import { expandRecurrence, MAX_OCCURRENCES } from '@/lib/calendar/recurrence';
import type { RecurrenceRule } from '@/lib/types/calendar';

const rule = (over: Partial<RecurrenceRule>): RecurrenceRule => ({
  type: 'weekly', interval: 1, endType: 'never', untilDate: null, count: null, ...over,
});

describe('expandRecurrence', () => {
  it('weekly count=5 yields exactly 5 dates, 7 days apart', () => {
    const { dates, capped } = expandRecurrence('2026-06-14', rule({ type: 'weekly', endType: 'count', count: 5 }));
    expect(dates).toEqual(['2026-06-14', '2026-06-21', '2026-06-28', '2026-07-05', '2026-07-12']);
    expect(capped).toBe(false);
  });

  it('daily interval=2 count=4', () => {
    const { dates } = expandRecurrence('2026-06-14', rule({ type: 'daily', interval: 2, endType: 'count', count: 4 }));
    expect(dates).toEqual(['2026-06-14', '2026-06-16', '2026-06-18', '2026-06-20']);
  });

  it('monthly clamps day-of-month on short months (Jan 31 -> Feb 28)', () => {
    const { dates } = expandRecurrence('2026-01-31', rule({ type: 'monthly', endType: 'count', count: 3 }));
    expect(dates[0]).toBe('2026-01-31');
    expect(dates[1]).toBe('2026-02-28'); // 2026 not a leap year
    expect(dates[2]).toBe('2026-03-31');
  });

  it('until_date stops cleanly (not capped)', () => {
    const { dates, capped } = expandRecurrence('2026-06-14', rule({ type: 'weekly', endType: 'until_date', untilDate: '2026-07-01' }));
    expect(dates).toEqual(['2026-06-14', '2026-06-21', '2026-06-28']);
    expect(capped).toBe(false);
  });

  it('never caps at MAX_OCCURRENCES', () => {
    const { dates, capped } = expandRecurrence('2026-06-14', rule({ type: 'daily', endType: 'never' }));
    expect(dates.length).toBe(MAX_OCCURRENCES);
    expect(capped).toBe(true);
  });

  it('count above MAX is clipped and flagged capped', () => {
    const { dates, capped } = expandRecurrence('2026-06-14', rule({ type: 'daily', endType: 'count', count: 500 }));
    expect(dates.length).toBe(MAX_OCCURRENCES);
    expect(capped).toBe(true);
  });

  it('18-month horizon caps a long monthly series', () => {
    const { dates, capped } = expandRecurrence('2026-06-14', rule({ type: 'monthly', endType: 'never' }));
    // monthly never -> ~18 months ahead before the horizon clips it
    expect(dates.length).toBeLessThanOrEqual(19);
    expect(capped).toBe(true);
  });

  it('seed is always first occurrence', () => {
    const { dates } = expandRecurrence('2026-12-25', rule({ type: 'yearly', endType: 'count', count: 2 }));
    expect(dates[0]).toBe('2026-12-25');
    expect(dates[1]).toBe('2027-12-25');
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeUnitPrice, plusDays, round2, summarizeQuote } from '@/lib/purchasing/model';

describe('normalizeUnitPrice', () => {
  it('leaves before-VAT prices as typed (to the agora)', () => {
    expect(normalizeUnitPrice(500, 'excl', 18)).toBe(500);
    expect(normalizeUnitPrice(12.5, 'excl', 18)).toBe(12.5);
  });
  it('divides a VAT-inclusive price by 1 + rate, rounded per unit', () => {
    expect(normalizeUnitPrice(118, 'incl', 18)).toBe(100);
    expect(normalizeUnitPrice(10, 'incl', 18)).toBe(8.47);
    expect(normalizeUnitPrice(1, 'incl', 18)).toBe(0.85);
    expect(normalizeUnitPrice(0, 'incl', 18)).toBe(0);
  });
  it('handles odd and zero rates', () => {
    expect(normalizeUnitPrice(117, 'incl', 17)).toBe(100);
    expect(normalizeUnitPrice(100, 'incl', 0)).toBe(100);
    expect(normalizeUnitPrice(105.5, 'incl', 5.5)).toBe(100);
    expect(normalizeUnitPrice(100, 'incl', 17.5)).toBe(85.11);
  });
});

describe('summarizeQuote', () => {
  const lines = [{ quantity: 1, entered: 500 }, { quantity: 1, entered: 600 }, { quantity: 1, entered: 900 }];
  it('excl: VAT on top of the subtotal (the design sample)', () => {
    expect(summarizeQuote(lines, 'excl', 18)).toEqual({ subtotal: 2000, vat: 360, total: 2360 });
  });
  it('incl: the entered totals are the total, VAT is what is left', () => {
    expect(summarizeQuote([{ quantity: 2, entered: 118 }, { quantity: 1, entered: 59 }], 'incl', 18)).toEqual({ subtotal: 250, vat: 45, total: 295 });
  });
  it('incl: before + VAT always equals the total, whatever the rounding', () => {
    for (const rate of [18, 17, 5.5, 0, 23]) {
      for (const entered of [0.01, 1, 3.33, 10, 99.99, 1234.56]) {
        const ls = [{ quantity: 3, entered }, { quantity: 7, entered: entered + 0.07 }];
        const s = summarizeQuote(ls, 'incl', rate);
        expect(round2(s.subtotal + s.vat)).toBe(s.total);
      }
    }
  });
  it('treats an unpriced line as zero and an empty list as zero', () => {
    expect(summarizeQuote([{ quantity: 2, entered: null }], 'excl', 18)).toEqual({ subtotal: 0, vat: 0, total: 0 });
    expect(summarizeQuote([], 'incl', 18)).toEqual({ subtotal: 0, vat: 0, total: 0 });
  });
});

describe('plusDays', () => {
  it('adds days across month and year ends', () => {
    expect(plusDays('2026-10-25', 14)).toBe('2026-11-08');
    expect(plusDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(plusDays('2028-02-20', 10)).toBe('2028-03-01');
  });
});

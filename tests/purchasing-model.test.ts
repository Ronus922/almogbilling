import { describe, expect, it } from 'vitest';
import {
  buildComparison, cheapestLineIndex, companyIsComplete, computeTotals, EMPTY_COMPANY, formatIls,
  isRfqOpen, quoteTotal, round2, sniffImage, validateBrandImage,
} from '@/lib/purchasing/model';

describe('money', () => {
  it('rounds half away from zero without float noise', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-1.005)).toBe(-1.01);
  });
  it('formats ₪1,250.00', () => {
    expect(formatIls(1250)).toBe('₪1,250.00');
    expect(formatIls(0.5)).toBe('₪0.50');
    expect(formatIls(1234567.891)).toBe('₪1,234,567.89');
  });
  it('totals: subtotal, VAT at the stamped rate, payable', () => {
    const t = computeTotals([{ quantity: 3, unit_price: 100 }, { quantity: 2.5, unit_price: 40.1 }], 18);
    expect(t).toEqual({ subtotal: 400.25, vat: 72.05, total: 472.3 });
    expect(computeTotals([{ quantity: 1, unit_price: 100 }], 0).total).toBe(100);
  });
});

describe('rfq due date', () => {
  it('is open through the due date inclusive, closed the next day', () => {
    expect(isRfqOpen('2026-10-21', '2026-10-21')).toBe(true);
    expect(isRfqOpen('2026-10-21', '2026-10-22')).toBe(false);
  });
});

describe('comparison', () => {
  const lines = [
    { id: 'l1', description: 'צבע', quantity: 10 },
    { id: 'l2', description: 'רולר', quantity: 2 },
  ];
  it('flags the cheapest total and handles a lump-sum-only offer', () => {
    const cols = buildComparison(lines, [
      { supplier_id: 'a', supplier_name: 'A', prices: { l1: 50, l2: 10 }, total_amount: null },
      { supplier_id: 'b', supplier_name: 'B', prices: { l1: 45, l2: 10 }, total_amount: null },
      { supplier_id: 'c', supplier_name: 'C', prices: {}, total_amount: 480 },
    ]);
    expect(cols.map((c) => c.total)).toEqual([520, 470, 480]);
    expect(cols.map((c) => c.cheapest)).toEqual([false, true, false]);
    expect(cols[2].lumpSum).toBe(true);
    expect(cols[2].lineTotals).toEqual([null, null]);
    expect(cheapestLineIndex(cols, 0)).toEqual([1]);
  });
  it('uses the lump sum for a partially priced offer, never a partial sum', () => {
    expect(quoteTotal(lines, { prices: { l1: 50 }, total_amount: 700 })).toEqual({ total: 700, lumpSum: true });
    expect(quoteTotal(lines, { prices: { l1: 50 }, total_amount: null })).toEqual({ total: null, lumpSum: false });
  });
  it('a lone offer is not flagged cheapest', () => {
    const cols = buildComparison(lines, [{ supplier_id: 'a', supplier_name: 'A', prices: { l1: 1, l2: 1 }, total_amount: null }]);
    expect(cols[0].cheapest).toBe(false);
  });
});

describe('brand images', () => {
  it('accepts PNG/JPG within 2MB only', () => {
    expect(validateBrandImage({ name: 'logo.png', size: 1000, type: 'image/png' })).toBeNull();
    expect(validateBrandImage({ name: 'logo.svg', size: 1000, type: 'image/svg+xml' })).not.toBeNull();
    expect(validateBrandImage({ name: 'logo.png', size: 3 * 1024 * 1024, type: 'image/png' })).not.toBeNull();
  });
  it('sniffs the real format from the bytes', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]))).toBe('png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
});

describe('company letterhead', () => {
  it('needs name, tax id, address, phone and e-mail', () => {
    expect(companyIsComplete(null)).toBe(false);
    expect(companyIsComplete(EMPTY_COMPANY)).toBe(false);
    expect(companyIsComplete({ ...EMPTY_COMPANY, name: 'א', tax_id: '1', address: 'ב', phone: '2', email: 'a@b.co' })).toBe(true);
  });
});

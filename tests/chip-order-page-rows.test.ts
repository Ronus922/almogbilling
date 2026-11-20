import { describe, expect, it } from 'vitest';
import { CHIP_ORDER_LIMITS, formatIlsAfter, priceBreakdown } from '@/lib/chipOrders/model';
import { chipOrderSubmitSchema } from '@/lib/validation/requests';

// The redesigned order page (20/11/2026): rows are PEOPLE, the price and the
// cap count per apartment over all its rows, and the contact block carries the
// address in three parts. The numbers below are the settings' defaults, used
// only as test inputs — the page always takes them from /settings.

const S = { unitPrice: 50, threshold: 2, priceAbove: 70 };

describe('priceBreakdown — the threshold counts per apartment over all its rows', () => {
  it('one apartment, two rows of 2 → 2 at the base price + 2 above', () => {
    // Rows are grouped by apartment BEFORE pricing: [2 + 2] for apartment A.
    const b = priceBreakdown([4], S);
    expect(b).toEqual({ base: 2, above: 2, baseTotal: 100, aboveTotal: 140, total: 240 });
  });
  it('two apartments × 2 → all four at the base price', () => {
    const b = priceBreakdown([2, 2], S);
    expect(b).toEqual({ base: 4, above: 0, baseTotal: 200, aboveTotal: 0, total: 200 });
  });
  it('uses the settings it is given (no fixed prices)', () => {
    const b = priceBreakdown([3], { unitPrice: 40, threshold: 1, priceAbove: 55.5 });
    expect(b).toEqual({ base: 1, above: 2, baseTotal: 40, aboveTotal: 111, total: 151 });
  });
  it('the total equals the sum of the per-apartment line prices', () => {
    const b = priceBreakdown([4, 1, 6], S);
    expect(b.total).toBe(b.baseTotal + b.aboveTotal);
  });
  it('the cap is 6 chips per apartment', () => {
    expect(CHIP_ORDER_LIMITS.maxChipsPerApartment).toBe(6);
  });
  it('formats the amount number-first, as the reference', () => {
    expect(formatIlsAfter(240)).toBe('240₪');
    expect(formatIlsAfter(1050)).toBe('1,050₪');
    expect(formatIlsAfter(52.5)).toBe('52.5₪');
  });
});

const base = {
  phone: '0521234567',
  email: 'a@example.com',
  addressStreet: 'הרצל 1',
  addressCity: 'חיפה',
  addressZip: '1234567',
  acceptTerms: true,
  rows: [{ role: 'owner', fullName: 'ישראל ישראלי', apartment: '101', chipsCount: 2, phone: '0521234567', email: '' }],
};

describe('chipOrderSubmitSchema — the rows shape', () => {
  it('accepts a minimal order', () => {
    expect(chipOrderSubmitSchema.safeParse(base).success).toBe(true);
  });
  it('offers owner and renter only — the operator option is gone from the page', () => {
    const r = chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], role: 'operator' }] });
    expect(r.success).toBe(false);
  });
  it('the zip is exactly 7 digits', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressZip: '123456' }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressZip: '12345678' }).success).toBe(false);
  });
  it('street, city and the "details are correct" box are required', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressStreet: '' }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressCity: '' }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, acceptTerms: false }).success).toBe(false);
  });
  it('a row needs a full name and a phone; its email is optional but checked', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], fullName: 'ישראל' }] }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], phone: '' }] }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], email: 'nope' }] }).success).toBe(false);
  });
  it('never carries card fields or a price', () => {
    const parsed = chipOrderSubmitSchema.parse({ ...base, cardNumber: '4111111111111111', total: 1 });
    expect(parsed).not.toHaveProperty('cardNumber');
    expect(parsed).not.toHaveProperty('total');
  });
});

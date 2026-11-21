import { describe, expect, it } from 'vitest';
import { CHIP_ORDER_LIMITS, formatIlsAfter, orderTotal, priceLine } from '@/lib/chipOrders/model';
import { chipOrderSubmitSchema } from '@/lib/validation/requests';

// The order page (20/11/2026 design, 21/11/2026 pricing): rows are PEOPLE, and
// every chip costs ONE flat price — total = all chips × the price of /settings,
// no threshold and no quantity limit. The prices below are test inputs only;
// the page always takes the price from /settings.

describe('priceLine — one flat price per chip', () => {
  it('chips × the unit price, whatever the count', () => {
    expect(priceLine(1, { unitPrice: 50 }).lineTotal).toBe(50);
    expect(priceLine(4, { unitPrice: 50 }).lineTotal).toBe(200);
    expect(priceLine(13, { unitPrice: 50 }).lineTotal).toBe(650);
  });
  it('uses the price it is given (no fixed price)', () => {
    expect(priceLine(3, { unitPrice: 55.5 }).lineTotal).toBe(166.5);
    expect(priceLine(3, { unitPrice: 0.1 }).lineTotal).toBe(0.3);
  });
  it('fills the old snapshot columns as one price: every chip at the base price', () => {
    expect(priceLine(7, { unitPrice: 40 })).toEqual({ unitPrice: 40, threshold: 7, priceAbove: 40, lineTotal: 280 });
  });
  it('the order total is the same however the chips split over apartments', () => {
    const split = orderTotal([4, 1, 6].map((n) => priceLine(n, { unitPrice: 50 })));
    expect(split).toBe(priceLine(11, { unitPrice: 50 }).lineTotal);
  });
  it('no business cap — only the storage ceiling of one apartment line (DB CHECK 50)', () => {
    expect(CHIP_ORDER_LIMITS).not.toHaveProperty('maxChipsPerApartment');
    expect(CHIP_ORDER_LIMITS).not.toHaveProperty('maxApartmentsPerOrder');
    expect(CHIP_ORDER_LIMITS.chipsPerApartmentCeiling).toBe(50);
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
  it('a row may order more than the old caps (no 4 / 6 per apartment)', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], chipsCount: 12 }] }).success).toBe(true);
  });
  it('never carries card fields or a price', () => {
    const parsed = chipOrderSubmitSchema.parse({ ...base, cardNumber: '4111111111111111', total: 1 });
    expect(parsed).not.toHaveProperty('cardNumber');
    expect(parsed).not.toHaveProperty('total');
  });
});

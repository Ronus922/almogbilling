import { describe, expect, it } from 'vitest';
import { CHIP_ORDER_APT_LIMIT_MESSAGE, CHIP_ORDER_LIMITS, formatIlsAfter, orderTotal, priceLine } from '@/lib/chipOrders/model';
import { chipOrderSubmitSchema } from '@/lib/validation/requests';

// The order page (20/11/2026 design, 21/11/2026 pricing): rows are PEOPLE, and
// every chip costs ONE flat price — total = all chips × the price of /settings,
// no threshold. One apartment orders up to 10 chips over all its rows (21/11
// noon). The prices below are test inputs only; the page always takes the
// price from /settings.

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
  it('up to 10 chips per apartment in one order; no cap on the apartments of an order', () => {
    expect(CHIP_ORDER_LIMITS.maxChipsPerApartment).toBe(10);
    expect(CHIP_ORDER_LIMITS).not.toHaveProperty('maxApartmentsPerOrder');
    expect(CHIP_ORDER_LIMITS).not.toHaveProperty('chipsPerApartmentCeiling');
    expect(CHIP_ORDER_APT_LIMIT_MESSAGE).toBe('ניתן להזמין עד 10 כרטיסים לדירה בהזמנה אחת. לכמות גדולה יותר יש לפנות להנהלת הבניין.');
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
  it('street and city are required', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressStreet: '' }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, addressCity: '' }).success).toBe(false);
  });
  it('the agreement boxes gate the PAYMENT, not the save (26/11/2026): unticked or absent still saves', () => {
    const { acceptTerms: _ticked, ...withoutBox } = base;
    void _ticked;
    expect(chipOrderSubmitSchema.safeParse({ ...base, acceptTerms: false }).success).toBe(true);
    expect(chipOrderSubmitSchema.safeParse(withoutBox).success).toBe(true);
    expect(chipOrderSubmitSchema.safeParse({ ...base, acceptTerms: 'yes' }).success).toBe(false);
  });
  it('a re-save names the order by its tracking token; a renter row may keep its lease by key', () => {
    const token = 'A'.repeat(43);
    expect(chipOrderSubmitSchema.safeParse({ ...base, trackingToken: token }).success).toBe(true);
    for (const bad of ['short', 'x'.repeat(65), `${'A'.repeat(42)}!`]) {
      expect(chipOrderSubmitSchema.safeParse({ ...base, trackingToken: bad }).success).toBe(false);
    }
    const key = '0f8fad5b-d9cb-469f-a165-70867728950e.pdf';
    const renter = { ...base.rows[0], role: 'tenant', leaseEndDate: '2030-01-01' };
    expect(chipOrderSubmitSchema.safeParse({ ...base, trackingToken: token, rows: [{ ...renter, leaseKey: key }] }).success).toBe(true);
    // A key is a bare stored object name — never a path or anything else.
    for (const bad of ['../other-order/lease.pdf', 'lease.pdf', `${key}/x`, '0F8FAD5B-D9CB-469F-A165-70867728950E.pdf']) {
      expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...renter, leaseKey: bad }] }).success).toBe(false);
    }
  });
  it('a row needs a full name and a phone; its email is optional but checked', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], fullName: 'ישראל' }] }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], phone: '' }] }).success).toBe(false);
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], email: 'nope' }] }).success).toBe(false);
  });
  it('a row orders up to 10 chips; past it the answer is the apartment message', () => {
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], chipsCount: 10 }] }).success).toBe(true);
    const r = chipOrderSubmitSchema.safeParse({ ...base, rows: [{ ...base.rows[0], chipsCount: 11 }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(CHIP_ORDER_APT_LIMIT_MESSAGE);
  });
  it('several apartments, each up to 10, pass the schema (the per-apartment sum is the route\'s)', () => {
    const rows = [
      { ...base.rows[0], apartment: '101', chipsCount: 10 },
      { ...base.rows[0], apartment: '102', chipsCount: 10 },
    ];
    expect(chipOrderSubmitSchema.safeParse({ ...base, rows }).success).toBe(true);
  });
  it('"הערות" is optional, trimmed, and up to 500 characters', () => {
    expect(chipOrderSubmitSchema.parse(base).note).toBeUndefined();
    expect(chipOrderSubmitSchema.parse({ ...base, note: '  למסור לשכן  ' }).note).toBe('למסור לשכן');
    expect(chipOrderSubmitSchema.safeParse({ ...base, note: 'א'.repeat(500) }).success).toBe(true);
    expect(chipOrderSubmitSchema.safeParse({ ...base, note: 'א'.repeat(501) }).success).toBe(false);
  });
  it('never carries card fields or a price', () => {
    const parsed = chipOrderSubmitSchema.parse({ ...base, cardNumber: '4111111111111111', total: 1 });
    expect(parsed).not.toHaveProperty('cardNumber');
    expect(parsed).not.toHaveProperty('total');
  });
});

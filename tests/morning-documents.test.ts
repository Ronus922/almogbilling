import { describe, expect, it } from 'vitest';
import {
  buildCreditBodies, buildInvoiceBody, chooseDocumentType, documentDescription, DocumentBuildError, incomeLinesOf,
  israelDate, MORNING_PAYMENT_TYPE, type CreditInput, type InvoiceInput,
} from '@/lib/morning/documents';

// The PURE half of the Morning documents of chip orders
// (src/lib/morning/documents.ts, 26/11/2026): which document the building's
// account issues for a paid sale, and every field of the request body that
// reaches Morning. No I/O here — the issuer and the queue are
// tests/chip-order-documents-db.test.ts; the HTTP client is
// tests/morning-client.test.ts.

describe('chooseDocumentType — the account decides; an unknown answer issues nothing', () => {
  it('a VAT-exempt business (type 3, or exemption true) → 400 "קבלה", no VAT', () => {
    for (const p of [
      { businessType: 3, exemption: null, availableTypes: null },
      { businessType: 1, exemption: true, availableTypes: null }, // Morning's own word beats the type
      { businessType: null, exemption: true, availableTypes: null },
      { businessType: 4, exemption: true, availableTypes: [400, 405] },
    ]) {
      const c = chooseDocumentType(p);
      expect(c, JSON.stringify(p)).toMatchObject({ docType: 400, vatIncluded: false });
      expect(c.reason).toContain('פטור');
    }
  });

  it('a VAT-registered business (type 1, 2, 6, or exemption false) → 320, the chip price includes VAT', () => {
    for (const p of [
      { businessType: 1, exemption: null, availableTypes: null },
      { businessType: 2, exemption: null, availableTypes: null },
      { businessType: 6, exemption: null, availableTypes: null },
      { businessType: null, exemption: false, availableTypes: null },
      { businessType: 3, exemption: false, availableTypes: null }, // Morning says NOT exempt
      { businessType: 5, exemption: false, availableTypes: [305, 320, 330, 400] },
    ]) {
      expect(chooseDocumentType(p), JSON.stringify(p)).toMatchObject({ docType: 320, vatIncluded: true });
    }
  });

  it('Morning did not say whether the business is exempt → NO document type (the queue waits)', () => {
    for (const p of [
      { businessType: null, exemption: null, availableTypes: null },
      { businessType: 4, exemption: null, availableTypes: null }, // עמותה — not assumed either way
      { businessType: 5, exemption: null, availableTypes: [320, 400] },
      { businessType: 99, exemption: null, availableTypes: null },
    ]) {
      const c = chooseDocumentType(p);
      expect(c, JSON.stringify(p)).toMatchObject({ docType: null, vatIncluded: false });
      expect(c.reason).toContain('מורנינג');
    }
  });

  it('a document type the account does not list as available → null, with the type in the reason', () => {
    const exempt = chooseDocumentType({ businessType: 3, exemption: null, availableTypes: [320, 330] });
    expect(exempt).toMatchObject({ docType: null, vatIncluded: false });
    expect(exempt.reason).toContain('400');
    const vat = chooseDocumentType({ businessType: 1, exemption: false, availableTypes: [400] });
    expect(vat).toMatchObject({ docType: null, vatIncluded: false });
    expect(vat.reason).toContain('320');
    // An empty list is a list: nothing is available.
    expect(chooseDocumentType({ businessType: 1, exemption: null, availableTypes: [] }).docType).toBeNull();
    // Listed → issued.
    expect(chooseDocumentType({ businessType: 1, exemption: null, availableTypes: [320] }).docType).toBe(320);
    expect(chooseDocumentType({ businessType: 3, exemption: null, availableTypes: [400] }).docType).toBe(400);
  });
});

describe('documentDescription and israelDate', () => {
  it('"כרטיסי בקרת כניסה — הזמנה N — דירה X", several apartments as "דירות X, Y", each once', () => {
    expect(documentDescription(1042, ['12'])).toBe('כרטיסי בקרת כניסה — הזמנה 1042 — דירה 12');
    expect(documentDescription(1042, ['12', '14'])).toBe('כרטיסי בקרת כניסה — הזמנה 1042 — דירות 12, 14');
    expect(documentDescription(7, ['3', '3', '', '5'])).toBe('כרטיסי בקרת כניסה — הזמנה 7 — דירות 3, 5');
    expect(documentDescription(7, ['3', '3'])).toBe('כרטיסי בקרת כניסה — הזמנה 7 — דירה 3');
    expect(documentDescription(7, [])).toBe('כרטיסי בקרת כניסה — הזמנה 7');
  });

  it('israelDate is the calendar day in Israel (winter +2, summer +3), never the UTC day', () => {
    expect(israelDate(new Date('2026-11-25T21:59:00Z'))).toBe('2026-11-25');
    expect(israelDate(new Date('2026-11-25T22:30:00Z'))).toBe('2026-11-26');
    expect(israelDate(new Date('2026-07-01T20:59:00Z'))).toBe('2026-07-01');
    expect(israelDate(new Date('2026-07-01T21:30:00Z'))).toBe('2026-07-02');
    expect(israelDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('incomeLinesOf — the apartment lines of an order as income rows', () => {
  it('merges lines of the same price into one row (several apartments, one flat price)', () => {
    expect(incomeLinesOf([
      { chipsCount: 3, unitPrice: 50, threshold: 3, priceAbove: 50 },
      { chipsCount: 2, unitPrice: 50, threshold: 2, priceAbove: 50 },
    ])).toEqual([{ quantity: 5, unitPrice: 50 }]);
  });

  it('honours a legacy threshold snapshot: the first `threshold` chips at unit_price, the rest at price_above — sorted by price', () => {
    expect(incomeLinesOf([{ chipsCount: 5, unitPrice: 50, threshold: 2, priceAbove: 40 }])).toEqual([
      { quantity: 3, unitPrice: 40 },
      { quantity: 2, unitPrice: 50 },
    ]);
    // Two lines whose prices meet: 2 @50 + 3 @40 and 1 @40 → 4 @40, 2 @50.
    expect(incomeLinesOf([
      { chipsCount: 5, unitPrice: 50, threshold: 2, priceAbove: 40 },
      { chipsCount: 1, unitPrice: 40, threshold: 1, priceAbove: 40 },
    ])).toEqual([{ quantity: 4, unitPrice: 40 }, { quantity: 2, unitPrice: 50 }]);
    // A threshold above the quantity: every chip at unit_price; a line of no chips: no row.
    expect(incomeLinesOf([
      { chipsCount: 2, unitPrice: 45, threshold: 10, priceAbove: 30 },
      { chipsCount: 0, unitPrice: 99, threshold: 0, priceAbove: 99 },
    ])).toEqual([{ quantity: 2, unitPrice: 45 }]);
  });

  it('keeps agorot exactly (52.5, 19.9)', () => {
    expect(incomeLinesOf([
      { chipsCount: 3, unitPrice: 19.9, threshold: 3, priceAbove: 19.9 },
      { chipsCount: 1, unitPrice: 52.5, threshold: 1, priceAbove: 52.5 },
    ])).toEqual([{ quantity: 3, unitPrice: 19.9 }, { quantity: 1, unitPrice: 52.5 }]);
  });
});

const CLIENT = { name: 'דנה בדיקה', email: 'dana@example.test', phone: '0539400001', street: 'הרצל 1', city: 'חיפה', zip: '3300000' };

const invoice = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  docType: 320,
  vatIncluded: true,
  orderNumber: 1042,
  apartments: ['12'],
  client: CLIENT,
  lines: [{ quantity: 3, unitPrice: 50 }],
  amount: 150,
  payment: { method: 'card', date: '2026-11-26', last4: '9844' },
  ref: 'CHTESTREF1',
  date: '2026-11-26',
  ...over,
});

describe('buildInvoiceBody — the document of a payment', () => {
  it('a 320 for a card payment: every field Morning receives', () => {
    expect(buildInvoiceBody(invoice())).toEqual({
      type: 320,
      lang: 'he',
      currency: 'ILS',
      vatType: 0,
      date: '2026-11-26',
      description: 'כרטיסי בקרת כניסה — הזמנה 1042 — דירה 12',
      remarks: 'מזהה: CHTESTREF1',
      client: {
        name: 'דנה בדיקה', emails: ['dana@example.test'], phone: '0539400001', address: 'הרצל 1', city: 'חיפה', zip: '3300000',
        country: 'IL', add: false,
      },
      // The chip price is final: VAT included in it (vatType 1).
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 3, price: 50, currency: 'ILS', vatType: 1 }],
      // Card = payment type 3, with the last four digits only.
      payment: [{ type: 3, date: '2026-11-26', price: 150, currency: 'ILS', cardNum: '9844', cardType: 0, dealType: 1, numPayments: 1 }],
      signed: true,
      attachment: true,
      rounding: false,
    });
  });

  it('a 400 of an exempt business: income rows with vatType 0', () => {
    const body = buildInvoiceBody(invoice({ docType: 400, vatIncluded: false }));
    expect(body.type).toBe(400);
    expect(body.income).toEqual([{ description: 'כרטיס בקרת כניסה', quantity: 3, price: 50, currency: 'ILS', vatType: 0 }]);
  });

  it('cash → payment type 1, a bank transfer → type 4, with no card fields; the amount is exactly what was paid', () => {
    expect(MORNING_PAYMENT_TYPE).toEqual({ cash: 1, card: 3, bank_transfer: 4 });
    const cash = buildInvoiceBody(invoice({ payment: { method: 'cash', date: '2026-11-25', last4: null } }));
    expect(cash.payment).toEqual([{ type: 1, date: '2026-11-25', price: 150, currency: 'ILS' }]);
    const transfer = buildInvoiceBody(invoice({ payment: { method: 'bank_transfer', date: '2026-11-24', last4: '1234' } }));
    expect(transfer.payment).toEqual([{ type: 4, date: '2026-11-24', price: 150, currency: 'ILS' }]);
    // A card without its last four digits: no cardNum at all.
    const bare = buildInvoiceBody(invoice({ payment: { method: 'card', date: '2026-11-26', last4: null } }));
    expect((bare.payment as Record<string, unknown>[])[0]).not.toHaveProperty('cardNum');
    expect((bare.payment as Record<string, unknown>[])[0]).toMatchObject({ type: 3, price: 150 });
  });

  it('several apartments and price rows; agorot add up exactly (3 × 19.9 = 59.7)', () => {
    const body = buildInvoiceBody(invoice({
      apartments: ['12', '14'],
      lines: [{ quantity: 3, unitPrice: 19.9 }, { quantity: 2, unitPrice: 50 }],
      amount: 159.7,
    }));
    expect(body.description).toBe('כרטיסי בקרת כניסה — הזמנה 1042 — דירות 12, 14');
    expect(body.income).toEqual([
      { description: 'כרטיס בקרת כניסה', quantity: 3, price: 19.9, currency: 'ILS', vatType: 1 },
      { description: 'כרטיס בקרת כניסה', quantity: 2, price: 50, currency: 'ILS', vatType: 1 },
    ]);
    expect((body.payment as { price: number }[])[0]!.price).toBe(159.7);
  });

  it('a client with no email, phone or address sends only the name (and the fixed country)', () => {
    const body = buildInvoiceBody(invoice({ client: { name: 'משלם בקבלה', email: null, phone: null, street: null, city: null, zip: null } }));
    expect(body.client).toEqual({ name: 'משלם בקבלה', country: 'IL', add: false });
  });

  it('rows that do not add up to the amount paid → DocumentBuildError, nothing is built', () => {
    expect(() => buildInvoiceBody(invoice({ amount: 149.99 }))).toThrow(DocumentBuildError);
    expect(() => buildInvoiceBody(invoice({ amount: 200 }))).toThrow(DocumentBuildError);
    expect(() => buildInvoiceBody(invoice({ lines: [], amount: 150 }))).toThrow(DocumentBuildError);
    expect(() => buildInvoiceBody(invoice({ lines: [], amount: 0 }))).toThrow(DocumentBuildError);
    const e = (() => { try { buildInvoiceBody(invoice({ amount: 100 })); } catch (x) { return x; } return null; })();
    expect(e).toBeInstanceOf(DocumentBuildError);
    expect((e as Error).message).toContain('150');
    expect((e as Error).message).toContain('100');
  });
});

const credit = (over: Partial<CreditInput> = {}): CreditInput => ({
  originalType: 320,
  originalId: 'morning-doc-original-1',
  vatIncluded: true,
  orderNumber: 1042,
  apartments: ['12'],
  client: CLIENT,
  lines: [{ quantity: 3, unitPrice: 50 }],
  amount: 150,
  payment: { method: 'card', date: '2026-11-27', last4: '9844' },
  ref: 'CHCREDIT01',
  date: '2026-11-27',
  ...over,
});

describe('buildCreditBodies — crediting a payment', () => {
  it('a 320 is credited by a 330 linked "cancel" AND a negative 400 that carries the payment only', () => {
    const bodies = buildCreditBodies(credit());
    expect(bodies).toHaveLength(2);
    const [creditInvoice, receipt] = bodies as [Record<string, unknown>, Record<string, unknown>];
    const common = {
      lang: 'he',
      currency: 'ILS',
      date: '2026-11-27',
      description: 'זיכוי — כרטיסי בקרת כניסה — הזמנה 1042 — דירה 12',
      remarks: 'מזהה: CHCREDIT01',
      client: {
        name: 'דנה בדיקה', emails: ['dana@example.test'], phone: '0539400001', address: 'הרצל 1', city: 'חיפה', zip: '3300000',
        country: 'IL', add: false,
      },
      linkedDocumentIds: ['morning-doc-original-1'],
      linkType: 'cancel',
      signed: true,
      attachment: true,
      rounding: false,
    };
    expect(creditInvoice).toEqual({
      ...common,
      type: 330,
      vatType: 0,
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 3, price: 50, currency: 'ILS', vatType: 1 }],
    });
    expect(receipt).toEqual({
      ...common,
      type: 400,
      vatType: 0,
      income: [],
      payment: [{ type: 3, date: '2026-11-27', price: -150, currency: 'ILS', cardNum: '9844', cardType: 0, dealType: 1, numPayments: 1 }],
    });
  });

  it('a 400 is credited by ONE negative 400 whose income rows are negative', () => {
    const bodies = buildCreditBodies(credit({ originalType: 400, vatIncluded: false, payment: { method: 'cash', date: '2026-11-27', last4: null } }));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      type: 400,
      vatType: 0,
      linkedDocumentIds: ['morning-doc-original-1'],
      linkType: 'cancel',
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 3, price: -50, currency: 'ILS', vatType: 0 }],
      payment: [{ type: 1, date: '2026-11-27', price: -150, currency: 'ILS' }],
    });
    expect(JSON.stringify(bodies)).not.toContain('"type":330');
  });

  it('a bank transfer credit carries payment type 4', () => {
    const [receipt] = buildCreditBodies(credit({ originalType: 400, vatIncluded: false, payment: { method: 'bank_transfer', date: '2026-11-27', last4: null } }));
    expect((receipt!.payment as Record<string, unknown>[])[0]).toEqual({ type: 4, date: '2026-11-27', price: -150, currency: 'ILS' });
  });

  it('a PARTIAL credit carries one row of the amount returned — on the 330 and on a 400 alike', () => {
    const [ci, r320] = buildCreditBodies(credit({ amount: 40 }));
    expect(ci!.income).toEqual([{ description: 'כרטיס בקרת כניסה', quantity: 1, price: 40, currency: 'ILS', vatType: 1 }]);
    expect(r320!.income).toEqual([]);
    expect((r320!.payment as { price: number }[])[0]!.price).toBe(-40);

    const [r400] = buildCreditBodies(credit({ originalType: 400, vatIncluded: false, amount: 52.5 }));
    expect(r400!.income).toEqual([{ description: 'כרטיס בקרת כניסה', quantity: 1, price: -52.5, currency: 'ILS', vatType: 0 }]);
    expect((r400!.payment as { price: number }[])[0]!.price).toBe(-52.5);
  });
});

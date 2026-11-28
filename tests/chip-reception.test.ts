import { describe, expect, it } from 'vitest';
import {
  CHIP_ORDER_RECEPTION_LABEL, RECEPTION_CARD_PENDING_TEXT, RECEPTION_CONFIRMED_METHODS, RECEPTION_MAX_PAID_CHIPS, RECEPTION_PAYMENT_LABEL,
  RECEPTION_PAYMENT_METHODS, STORED_PAYMENT_LABEL, composeReceptionAddress, looksLikeEmail, ordererProblems, receptionAmount,
  receptionMethodInForce, receptionPaymentReason, receptionRecordsOf, sameAmount, type OrdererFields, type ReceptionPaymentMethod,
  type ReceptionRecordView,
} from '@/lib/chipOrders/reception';
import { chipHolderDetails } from '@/lib/chips/holder';
import { chipGroupDetailsSchema, chipHolderUpdatesSchema, chipOrderWindowSaveSchema, chipReceptionSchema } from '@/lib/validation/requests';
import { validatePhone } from '@/lib/validation';

// Issuing a chip at the reception (25/11/2026) — the pure half: the payment
// methods of the issue window without an order, the amount of a save (new
// chips × the price per chip of /settings), the orderer details (every field
// optional), why a save of new chips cannot go yet, and what the server
// accepts of `orderer`, `payment`, a block's email and a renter's lease.
// 26/11/2026: "מזומן או העברה" is two methods, "מזומן" and "העברה בנקאית"
// (an order recorded before keeps "מזומן או העברה" — STORED_PAYMENT_LABEL),
// and "אשראי" is a method the server knows (a payment OF a sum).

const phoneProblem = (p: string) => {
  const v = validatePhone(p);
  return v.valid ? null : v.error ?? 'מספר טלפון לא תקין';
};
const EMPTY: OrdererFields = { name: '', phone: '', email: '', street: '', city: '', zip: '' };
const KEY = '11111111-1111-4111-8111-111111111111.pdf';

describe('the payment methods of the reception window', () => {
  it('four methods a save can carry — cash and a bank transfer are two (26/11/2026)', () => {
    expect(RECEPTION_PAYMENT_METHODS).toEqual(['cash', 'bank_transfer', 'card', 'none']);
    expect(RECEPTION_PAYMENT_LABEL).toEqual({ card: 'אשראי', cash: 'מזומן', bank_transfer: 'העברה בנקאית', none: 'ללא חיוב' });
    // The methods that are a received SUM the manager confirms by choosing them.
    expect(RECEPTION_CONFIRMED_METHODS).toEqual(['cash', 'bank_transfer']);
    expect(RECEPTION_CARD_PENDING_TEXT).toBe('יופעל לאחר חיבור הסליקה');
    expect(CHIP_ORDER_RECEPTION_LABEL).toBe('קבלה');
  });

  it('a STORED method in words — the one recorded before the split is shown as it was', () => {
    expect(STORED_PAYMENT_LABEL).toEqual({ cash: 'מזומן', bank_transfer: 'העברה בנקאית', card: 'אשראי', cash_transfer: 'מזומן או העברה' });
    // "ללא חיוב" is never a stored method: a no-charge save makes no order.
    expect(STORED_PAYMENT_LABEL.none).toBeUndefined();
  });

  it('the amount: new chips × the price per chip, agorot-safe', () => {
    expect(receptionAmount(2, 50)).toBe(100);
    expect(receptionAmount(1, 50)).toBe(50);
    expect(receptionAmount(0, 50)).toBe(0);
    expect(receptionAmount(3, 52.5)).toBe(157.5);
    expect(receptionAmount(3, 33.33)).toBe(99.99); // never 99.99000000000001
    expect(receptionAmount(7, 0.1)).toBe(0.7);
  });

  it('two sums are the same sum when their agorot are', () => {
    expect(sameAmount(100, 100)).toBe(true);
    expect(sameAmount(157.5, 157.50000000001)).toBe(true);
    expect(sameAmount(100, 100.01)).toBe(false);
    expect(sameAmount(100, 150)).toBe(false);
  });
});

describe('why a save of new chips cannot go yet', () => {
  const reason = (newChips: number, method: ReceptionPaymentMethod | null, amount: number | null) =>
    receptionPaymentReason({ newChips, method, amount });

  it('no new chip — nothing to pay for, whatever is chosen', () => {
    expect(reason(0, null, 0)).toBeNull();
    expect(reason(0, 'cash', 0)).toBeNull();
    expect(reason(0, 'bank_transfer', 0)).toBeNull();
    expect(reason(0, 'card', 0)).toBeNull();
    expect(reason(0, null, null)).toBeNull();
  });

  it('new chips and nothing chosen — the manager must choose', () => {
    expect(reason(2, null, 100)).toBe('יש לבחור אמצעי תשלום כדי להנפיק את הצ׳יפים החדשים');
  });

  it('"ללא חיוב" always goes — also when the price could not be loaded', () => {
    expect(reason(2, 'none', 100)).toBeNull();
    expect(reason(2, 'none', null)).toBeNull();
    expect(reason(200, 'none', 10_000)).toBeNull(); // the ceiling is of a PAID save only
  });

  it('"מזומן" and "העברה בנקאית" each confirm a SUM: when the sum on the screen is another one, the choice no longer stands', () => {
    for (const method of ['cash', 'bank_transfer'] as const) {
      // Chosen at 100 and still 100: it stands.
      expect(receptionMethodInForce({ method, amount: 100, confirmedAmount: 100 })).toBe(method);
      expect(receptionPaymentReason({ newChips: 2, method, amount: 100, confirmedAmount: 100 })).toBeNull();
      // A third chip was added after 100 was confirmed: nothing is confirmed any more.
      expect(receptionMethodInForce({ method, amount: 150, confirmedAmount: 100 })).toBeNull();
      expect(receptionPaymentReason({ newChips: 3, method, amount: 150, confirmedAmount: 100 }))
        .toBe('הסכום לתשלום השתנה — יש לבחור שוב את אמצעי התשלום כדי לאשר את הסכום החדש');
      // …and back to two chips: the sum that was confirmed is the sum again.
      expect(receptionMethodInForce({ method, amount: 100, confirmedAmount: 100.004 })).toBe(method);
      // The price could not be loaded: the choice is kept until there is a sum to hold it to.
      expect(receptionMethodInForce({ method, amount: null, confirmedAmount: 100 })).toBe(method);
    }
    // "ללא חיוב" confirms no sum, and nothing chosen stays nothing.
    expect(receptionMethodInForce({ method: 'none', amount: 150, confirmedAmount: 100 })).toBe('none');
    expect(receptionMethodInForce({ method: null, amount: 150, confirmedAmount: 100 })).toBeNull();
    expect(receptionPaymentReason({ newChips: 3, method: 'none', amount: 150, confirmedAmount: 100 })).toBeNull();
  });

  it('"מזומן" / "העברה בנקאית" need a real sum the window knows, within one order line', () => {
    for (const method of ['cash', 'bank_transfer'] as const) {
      expect(reason(2, method, 100)).toBeNull();
      expect(reason(2, method, null)).toContain('המחיר לצ׳יפ לא נטען');
      expect(reason(2, method, 0)).toContain('ללא חיוב');
      expect(reason(RECEPTION_MAX_PAID_CHIPS, method, 2500)).toBeNull();
      expect(reason(RECEPTION_MAX_PAID_CHIPS + 1, method, 2550)).toContain(`עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים`);
    }
  });

  it('"אשראי" is a payment OF a sum: nothing goes before the card paid, and the sum it paid must be the sum now', () => {
    // Chosen, not paid yet (no sum the card paid).
    expect(receptionPaymentReason({ newChips: 2, method: 'card', amount: 100 })).toBe('יש להשלים את התשלום באשראי לפני השמירה');
    expect(receptionPaymentReason({ newChips: 2, method: 'card', amount: 100, confirmedAmount: null })).toBe('יש להשלים את התשלום באשראי לפני השמירה');
    // Paid 100 for two chips, still two: it stands.
    expect(receptionMethodInForce({ method: 'card', amount: 100, confirmedAmount: 100 })).toBe('card');
    expect(receptionPaymentReason({ newChips: 2, method: 'card', amount: 100, confirmedAmount: 100 })).toBeNull();
    // A chip was added after the card paid: the card's sum is not the sum now.
    expect(receptionMethodInForce({ method: 'card', amount: 150, confirmedAmount: 100 })).toBeNull();
    expect(receptionPaymentReason({ newChips: 3, method: 'card', amount: 150, confirmedAmount: 100 }))
      .toBe('הסכום שנגבה באשראי אינו הסכום לתשלום עכשיו — יש להחזיר את מספר הצ׳יפים, או לבטל את ההזמנה (זיכוי)');
    // The ceiling of a paid save holds for a card too.
    expect(receptionPaymentReason({ newChips: RECEPTION_MAX_PAID_CHIPS + 1, method: 'card', amount: 2550, confirmedAmount: 2550 }))
      .toContain(`עד ${RECEPTION_MAX_PAID_CHIPS} צ׳יפים`);
  });
});

describe('the orderer details — nothing is required of the manager', () => {
  it('an empty form has no problem at all', () => {
    expect(ordererProblems(EMPTY, phoneProblem)).toEqual({});
  });

  it('a full, valid form has none either', () => {
    expect(ordererProblems(
      { name: 'דנה כהן', phone: '052-1234567', email: 'dana@example.test', street: 'הרצל 5', city: 'חיפה', zip: '3303105' },
      phoneProblem,
    )).toEqual({});
  });

  it('only a value that IS there is checked', () => {
    // The name has no rule of its own: it follows the first chip holder, and a guest may be known by one letter.
    expect(ordererProblems({ ...EMPTY, name: 'ד' }, phoneProblem)).toEqual({});
    expect(ordererProblems({ ...EMPTY, phone: '123' }, phoneProblem)).toHaveProperty('phone');
    expect(ordererProblems({ ...EMPTY, email: 'dana@' }, phoneProblem)).toEqual({ email: 'כתובת מייל לא תקינה' });
    expect(ordererProblems({ ...EMPTY, street: 'א' }, phoneProblem)).toEqual({ street: 'הכתובת קצרה מדי' });
    expect(ordererProblems({ ...EMPTY, city: 'ח' }, phoneProblem)).toEqual({ city: 'שם העיר קצר מדי' });
    expect(ordererProblems({ ...EMPTY, zip: '12345' }, phoneProblem)).toEqual({ zip: 'מיקוד — 7 ספרות' });
    expect(looksLikeEmail(' dana@example.test ')).toBe(true);
    expect(looksLikeEmail('dana example.test')).toBe(false);
  });

  it('the address in one line, with whatever parts there are', () => {
    expect(composeReceptionAddress({ street: 'הרצל 5', city: 'חיפה', zip: '3303105' })).toBe('הרצל 5, חיפה 3303105');
    expect(composeReceptionAddress({ street: 'הרצל 5', city: null, zip: null })).toBe('הרצל 5');
    expect(composeReceptionAddress({ street: null, city: 'חיפה', zip: null })).toBe('חיפה');
    expect(composeReceptionAddress({ street: ' ', city: '', zip: null })).toBeNull();
  });
});

describe('what a block and a holder show again', () => {
  const chip = (over: Partial<Parameters<typeof chipHolderDetails>[0][number]> & { reception_record_id?: string | null; order_item_id?: string | null }) => ({
    holder_email: null, lease_file_key: null, lease_file_name: null, lease_end_date: null, reception_record_id: null, order_item_id: null, ...over,
  });
  const record = (ref: string, kind: 'record' | 'order'): ReceptionRecordView => ({
    kind, ref, order_number: kind === 'order' ? 1042 : null, created_at: '2026-11-25T08:00:00Z', orderer_name: 'דנה כהן', orderer_phone: null,
    orderer_email: null, address: null, chips_count: 1, amount: kind === 'order' ? 50 : 0, by_name: 'מנהל', cancelled: false,
    payment_method: kind === 'order' ? 'cash' : null, order_id: null, cancel_failed_step: null, cancel_error: null, closed_by_hand: false,
  });

  it('the email, the lease and its end date of a person: the first chip that has each', () => {
    expect(chipHolderDetails([])).toEqual({ email: null, lease: null, leaseEnd: null });
    expect(chipHolderDetails([
      chip({}),
      chip({ holder_email: 'a@example.test' }),
      chip({ lease_file_key: KEY, lease_file_name: 'חוזה.pdf', lease_end_date: '2027-06-30', holder_email: 'b@example.test' }),
    ])).toEqual({ email: 'a@example.test', lease: { key: KEY, name: 'חוזה.pdf', mime: null, size: null }, leaseEnd: '2027-06-30' });
    // An end date with no file is still shown.
    expect(chipHolderDetails([chip({ lease_end_date: '2028-01-31' })])).toEqual({ email: null, lease: null, leaseEnd: '2028-01-31' });
  });

  it('the reception saves of THESE chips — a no-charge record by its id, a reception order by its line', () => {
    const records = [record('rec-1', 'record'), record('item-1', 'order'), record('rec-other', 'record')];
    expect(receptionRecordsOf([chip({ reception_record_id: 'rec-1' }), chip({ order_item_id: 'item-1' })], records).map((r) => r.ref)).toEqual(['rec-1', 'item-1']);
    expect(receptionRecordsOf([chip({ reception_record_id: 'rec-1' }), chip({ reception_record_id: 'rec-1' })], records).map((r) => r.ref)).toEqual(['rec-1']);
    // A chip of a web order (its line is no reception record), and a chip from before all this.
    expect(receptionRecordsOf([chip({ order_item_id: 'web-item' }), chip({})], records)).toEqual([]);
  });
});

describe('what the server accepts: `orderer` and `payment` of POST /api/chips', () => {
  it('neither is there (holder edits only) — an empty orderer and no payment', () => {
    const r = chipReceptionSchema.parse({});
    expect(r.payment).toBeNull();
    expect(r.orderer).toEqual({ name: null, phone: null, email: null, street: null, city: null, zip: null });
  });

  it('blanks are nothing; the phone is normalised and the email lower-cased', () => {
    const r = chipReceptionSchema.parse({
      orderer: { name: '  דנה כהן ', phone: '052-123 4567', email: ' Dana@Example.TEST ', street: '', city: '  ', zip: null },
      payment: { method: 'cash', amount: 100 },
    });
    expect(r.orderer).toEqual({ name: 'דנה כהן', phone: '0521234567', email: 'dana@example.test', street: null, city: null, zip: null });
    expect(r.payment).toEqual({ method: 'cash', amount: 100 });
    expect(chipReceptionSchema.parse({ payment: { method: 'bank_transfer', amount: 150 } }).payment).toEqual({ method: 'bank_transfer', amount: 150 });
  });

  it('the four methods of 26/11/2026 — the old "cash_transfer" is refused (a tab from before the split reloads), and a sum is never negative', () => {
    for (const method of ['cash', 'bank_transfer', 'card', 'none']) {
      expect(chipReceptionSchema.safeParse({ payment: { method, amount: 100 } }).success, method).toBe(true);
    }
    const legacy = chipReceptionSchema.safeParse({ payment: { method: 'cash_transfer', amount: 100 } });
    expect(legacy.success).toBe(false);
    expect(legacy.error?.issues[0]?.message).toBe('אמצעי התשלום אינו תקין — רעננו את הדף');
    expect(chipReceptionSchema.safeParse({ payment: { method: 'cash', amount: -1 } }).success).toBe(false);
    expect(chipReceptionSchema.safeParse({ payment: { method: 'bank_transfer' } }).success).toBe(false);
    expect(chipReceptionSchema.safeParse({ payment: { method: 'none', amount: 0 } }).success).toBe(true);
  });

  it('the extra chips of a web order: cash, a bank transfer or no charge — never a card, never the old value', () => {
    const extra = (method: string) => chipOrderWindowSaveSchema.safeParse({ holders: [], extra_payment: { method, amount: 50 } }).success;
    expect(extra('cash')).toBe(true);
    expect(extra('bank_transfer')).toBe(true);
    expect(extra('none')).toBe(true);
    expect(extra('card')).toBe(false);
    expect(extra('cash_transfer')).toBe(false);
  });

  it('a value that is there must be storable — each refusal names its field', () => {
    const bad = (orderer: Record<string, string>) => {
      const r = chipReceptionSchema.safeParse({ orderer });
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(bad({ name: 'ד' })).toBeNull(); // a one-letter name is storable (an ORDER asks for two — the save says so)
    expect(bad({ name: 'א'.repeat(121) })).toBe('שם המזמין ארוך מדי');
    expect(bad({ phone: '12' })).toBeTruthy();
    expect(bad({ email: 'nope' })).toBe('כתובת מייל לא תקינה');
    expect(bad({ street: 'א' })).toBe('הכתובת קצרה מדי');
    expect(bad({ city: 'ח' })).toBe('שם העיר קצר מדי');
    expect(bad({ zip: '33031' })).toBe('מיקוד — 7 ספרות');
    expect(bad({ zip: '3303105' })).toBeNull();
  });
});

describe('what the server accepts: a block\'s email and a renter\'s lease', () => {
  it('a group without them carries nulls', () => {
    expect(chipGroupDetailsSchema.parse({})).toEqual({ holder_email: null, lease: null, lease_end_date: null, block: null });
  });

  it('a group with them: the email lower-cased, the lease as a reference, the date as a day', () => {
    expect(chipGroupDetailsSchema.parse({
      holder_email: 'Renter@Example.TEST', block: 3, lease_end_date: '2027-06-30',
      lease: { key: KEY, name: 'חוזה שכירות.pdf', mime: 'application/pdf', size: 1234 },
    })).toEqual({
      holder_email: 'renter@example.test', block: 3, lease_end_date: '2027-06-30',
      lease: { key: KEY, name: 'חוזה שכירות.pdf', mime: 'application/pdf', size: 1234 },
    });
  });

  it('a lease key is the bare <uuid>.<ext> the upload route makes — never a path, never another kind of file', () => {
    const ok = (key: string) => chipGroupDetailsSchema.safeParse({ lease: { key, name: 'x.pdf' } }).success;
    expect(ok(KEY)).toBe(true);
    expect(ok('11111111-1111-4111-8111-111111111111.webp')).toBe(true);
    expect(ok(`../${KEY}`)).toBe(false);
    expect(ok(`leases/${KEY}`)).toBe(false);
    expect(ok('11111111-1111-4111-8111-111111111111.exe')).toBe(false);
    expect(ok('11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(ok('lease.pdf')).toBe(false);
  });

  it('an email that is no email, a day that is no day and a block that is no block are refused', () => {
    expect(chipGroupDetailsSchema.safeParse({ holder_email: 'nope' }).success).toBe(false);
    expect(chipGroupDetailsSchema.safeParse({ lease_end_date: '30/06/2027' }).success).toBe(false);
    expect(chipGroupDetailsSchema.safeParse({ lease_end_date: '2027-13-45' }).success).toBe(false);
    // A day that does not exist: JavaScript would read it as the 2nd of March, the database refuses it.
    expect(chipGroupDetailsSchema.safeParse({ lease_end_date: '2027-02-30' }).success).toBe(false);
    expect(chipGroupDetailsSchema.safeParse({ lease_end_date: '2027-02-29' }).success).toBe(false);
    expect(chipGroupDetailsSchema.safeParse({ lease_end_date: '2028-02-29' }).success).toBe(true); // a leap year
    expect(chipGroupDetailsSchema.safeParse({ block: -1 }).success).toBe(false);
    expect(chipGroupDetailsSchema.safeParse({ block: 1.5 }).success).toBe(false);
  });

  it('a holder edit: only what is present is carried — a null lease takes it off, an empty email clears it', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(chipHolderUpdatesSchema.parse([{ id, holder_name: 'דנה' }])).toEqual([{ id, holder_name: 'דנה' }]);
    expect(chipHolderUpdatesSchema.parse([{ id, holder_email: 'A@Example.test' }])).toEqual([{ id, holder_email: 'a@example.test' }]);
    expect(chipHolderUpdatesSchema.parse([{ id, holder_email: '' }])).toEqual([{ id, holder_email: null }]);
    expect(chipHolderUpdatesSchema.parse([{ id, lease: null, lease_end_date: null }])).toEqual([{ id, lease: null, lease_end_date: null }]);
    expect(chipHolderUpdatesSchema.parse([{ id, lease: { key: KEY, name: 'חוזה.pdf' }, lease_end_date: '2027-06-30' }]))
      .toEqual([{ id, lease: { key: KEY, name: 'חוזה.pdf', mime: null, size: null }, lease_end_date: '2027-06-30' }]);
    expect(chipHolderUpdatesSchema.safeParse([{ id, lease: { key: 'x.pdf', name: 'x.pdf' } }]).success).toBe(false);
  });
});

// /chip-order — the contact card's "פרטי ההתקשרות זהים לפרטי השורה הראשונה"
// box (26/11/2026, Ronen): the contact RULES and where their messages show —
// ticked, on the first row's fields, with the first row's email required.
// The UI side (the box ticked by default, the read-only line following the
// first row, the inputs coming back prefilled, the order saved with the
// contact's own different values) is in e2e/chip-orders.spec.ts, "test mode"
// → "the contact box: …".
import { describe, expect, it } from 'vitest';
import { CONTACT_TEXT, contactErrors, contactFieldKey } from '@/lib/chipOrders/contact';

const FIRST = { phone: '0539312345', email: 'first@example.test' };
const OWN = { phone: '0541112222', email: 'own@example.test' };

describe('contactErrors — the contact rules, and the field each message shows on', () => {
  it('valid details: no problem, ticked or not', () => {
    expect(contactErrors(FIRST, true, 0)).toEqual({});
    expect(contactErrors(OWN, false, 0)).toEqual({});
  });

  it('ticked: the first row\'s email is REQUIRED (the receipt goes to it) — the message on that row\'s email field', () => {
    expect(contactErrors({ phone: FIRST.phone, email: '' }, true, 7)).toEqual({ email_7: CONTACT_TEXT.emailRequired });
    expect(contactErrors({ phone: FIRST.phone, email: '   ' }, true, 7)).toEqual({ email_7: CONTACT_TEXT.emailRequired });
  });

  it('ticked: an invalid email is "not valid" on the first row\'s field', () => {
    expect(contactErrors({ phone: FIRST.phone, email: 'not-an-email' }, true, 7)).toEqual({ email_7: CONTACT_TEXT.emailInvalid });
  });

  it('ticked: a first row phone that is not an Israeli mobile is refused as the contact phone, on that row\'s field', () => {
    // A foreign number is fine for a row — not for the contact details (the SMS / WhatsApp of the order).
    expect(contactErrors({ phone: '+447700900123', email: FIRST.email }, true, 3)).toEqual({ phone_3: CONTACT_TEXT.phoneIsraeliSame });
    expect(contactErrors({ phone: '048123456', email: FIRST.email }, true, 3)).toEqual({ phone_3: CONTACT_TEXT.phoneIsraeliSame });
  });

  it('unticked: the card\'s own fields, with the messages they always had', () => {
    expect(contactErrors({ phone: '', email: '' }, false, 3)).toEqual({
      phone: CONTACT_TEXT.phoneIsraeli,
      email: CONTACT_TEXT.emailInvalid,
    });
    expect(CONTACT_TEXT.phoneIsraeli).toBe('נדרש מספר טלפון נייד ישראלי');
    expect(CONTACT_TEXT.emailInvalid).toBe('כתובת מייל לא תקינה');
  });

  it('an Israeli mobile in any of its forms passes', () => {
    for (const phone of ['0539312345', '053-931-2345', '+972539312345', '972539312345']) {
      expect(contactErrors({ phone, email: FIRST.email }, true, 0), phone).toEqual({});
    }
  });
});

describe('contactFieldKey — where the server\'s contact problems show', () => {
  it('ticked → the first row\'s field; unticked → the card\'s own', () => {
    expect(contactFieldKey('phone', true, 4)).toBe('phone_4');
    expect(contactFieldKey('email', true, 4)).toBe('email_4');
    expect(contactFieldKey('phone', false, 4)).toBe('phone');
    expect(contactFieldKey('email', false, 4)).toBe('email');
  });
});

import { describe, expect, it } from 'vitest';
import { cardFailureMessage, cardHolderPhone, isValidIsraeliId, sdkSaysRefused, hostedFieldsCss } from '@/lib/chipOrders/card';

// Card payment of /chip-order — the pure part the form uses: the holder's ID
// check, the phone 3-D Secure needs, what the customer reads when a charge is
// refused, and what counts as the SDK "claiming" a success.

describe('isValidIsraeliId', () => {
  it('accepts valid numbers (check digit), with or without leading zeros', () => {
    expect(isValidIsraeliId('123456782')).toBe(true);
    expect(isValidIsraeliId('000000018')).toBe(true);
    expect(isValidIsraeliId('00018')).toBe(true);
  });

  it('refuses a wrong check digit, letters, too few or too many digits, all zeros', () => {
    for (const id of ['123456789', '12345678a', '1234', '1234567890', '000000000', '', '12 345 678']) {
      expect(isValidIsraeliId(id), id).toBe(false);
    }
  });
});

describe('cardHolderPhone — country code, no plus, no leading zero', () => {
  it('turns the order phone into the form 3-D Secure wants', () => {
    expect(cardHolderPhone('+972539400001')).toBe('972539400001');
    expect(cardHolderPhone(null)).toBe('');
    expect(cardHolderPhone(undefined)).toBe('');
  });
});

describe('cardFailureMessage — always Hebrew, never the raw text', () => {
  const HEBREW = /\p{Script=Hebrew}/u;
  it('maps what the SDK returns to a line of ours', () => {
    expect(cardFailureMessage({ success: false, message: 'credit-card-number-is-invalid' })).toContain('מספר הכרטיס');
    expect(cardFailureMessage({ success: false, errors: [{ field: 'expiry', fldType: 'hosted_field', message: 'expiry-date-is-invalid' }] })).toContain('תוקף');
    expect(cardFailureMessage({ success: false, errors: [{ field: 'cvv', message: 'cvv-is-required' }] })).toContain('CVV');
    expect(cardFailureMessage({ success: false, message: 'recaptcha-confirmation-is-missing' })).toContain('רובוט');
    expect(cardFailureMessage({ success: false, data: { status_description: 'Transaction declined by issuer' } })).toContain('נדחתה');
    expect(cardFailureMessage({ success: false, errors: [{ field: 'card_holder_id', message: 'required' }] })).toContain('תעודת הזהות');
  });

  it('never tells the customer the card was not charged on its own authority', () => {
    for (const reply of [{ success: false, message: 'gateway timeout' }, { success: false, message: 'declined' }, { success: false }]) {
      expect(cardFailureMessage(reply)).not.toContain('לא חויב');
    }
  });

  it('anything unknown gets the general line', () => {
    for (const reply of [{ success: false }, { success: false, message: 'zz-unknown-code-17' }, null, 'text', 42, {}]) {
      const text = cardFailureMessage(reply);
      expect(text).toMatch(HEBREW);
      expect(text).not.toContain('zz-unknown-code-17');
    }
  });
});

describe('sdkSaysRefused — only a definite refusal is one', () => {
  it('an explicit success:false with a plain refusal text', () => {
    expect(sdkSaysRefused({ success: false, message: 'credit-card-declined' })).toBe(true);
    expect(sdkSaysRefused({ success: false, errors: [{ field: 'cc', fldType: 'hosted_field', message: 'invalid' }] })).toBe(true);
    expect(sdkSaysRefused({ success: false })).toBe(true);
  });

  it('a success, an unknown shape, a timeout or "pending" is NOT a refusal — the server is asked first', () => {
    for (const reply of [
      { success: true }, { results: { status: 'success' } }, { data: { status: 'approved' } }, {}, null, 'timeout', 42,
      { success: false, message: 'gateway timeout' }, { success: false, message: 'network-error' },
      { success: false, data: { status: 'pending' } }, { success: false, message: 'service unavailable, try again later' },
    ]) {
      expect(sdkSaysRefused(reply), JSON.stringify(reply)).toBe(false);
    }
  });
});

// The two replies the SDK really gives (the sandbox, 25/11/2026) — their shape,
// with invented values.
describe('the SDK replies seen on the sandbox', () => {
  const approved = {
    status: 'success', redirect: false, type: 'credit-card', openStyle: '_top',
    data: { transaction_uid: 'bbbbbbbb-1111-2222-3333-444444444444', type: 'Charge', status: 'approved', status_code: '000', amount: 50, more_info: '1271' },
  };
  const fieldRefused = {
    success: false, status: 'reject', status_code: 999996, message: 'credit-card-number-is-incorrect', redirect: false, number_of_tries: 1,
    errors: [{ field: 'cc', message: 'credit-card-number-is-incorrect', fldType: 'hosted_field' }],
  };

  it('an approved charge carries no `success` key — it is not a refusal, the server is asked', () => {
    expect(sdkSaysRefused(approved)).toBe(false);
  });

  it('a number the card field itself refuses is a definite refusal, with the line about the card number', () => {
    expect(sdkSaysRefused(fieldRefused)).toBe(true);
    expect(cardFailureMessage(fieldRefused)).toBe('מספר הכרטיס שגוי.');
  });
});

describe('hostedFieldsCss — the style handed to the card-field frames', () => {
  const css = hostedFieldsCss('https://example.test', true);

  it('holds no quotation mark: the frame escapes them and the declaration is then dropped', () => {
    expect(css).not.toMatch(/["'`]/);
    expect(css).not.toContain('&');
  });

  it('addresses the frame\'s own input with a selector stronger than the frame\'s rule', () => {
    expect(css).toContain('html body main #hosted-fld,html body main #hosted-fld:disabled{');
    expect(css).toContain('html body main #hosted-fld::placeholder{');
  });

  it('matches the form\'s digit inputs: Inter 600, tabular digits, the ink and ghost colors, 14px padding', () => {
    for (const part of ['font-family:Inter,Heebo,Arial,sans-serif', 'font-weight:600', 'font-variant-numeric:tabular-nums', 'color:#1a2233', 'padding:0 14px', 'direction:ltr', 'color:#b4bacb']) {
      expect(css).toContain(part);
    }
  });

  it('16px on a phone (no zoom on iOS), 14px from 621px — like the inputs', () => {
    expect(hostedFieldsCss('https://example.test', true)).toContain('font-size:14px');
    expect(hostedFieldsCss('https://example.test', false)).toContain('font-size:16px');
  });

  it('names the font of the page by a URL of the page\'s own origin, bare', () => {
    expect(css).toContain('@font-face{font-family:Inter;');
    expect(css).toContain('src:url(https://example.test/api/public/chip-order/card-font)}');
  });

  it('names no font from an origin that is not public https (the filter in front of PayPlus refuses such a frame), or when asked not to', () => {
    for (const origin of ['http://localhost:3102', 'https://localhost', 'http://example.test', 'https://example.test:8443', 'https://127.0.0.1']) {
      const out = hostedFieldsCss(origin, true);
      expect(out).not.toContain('@font-face');
      expect(out).not.toContain('url(');
      expect(out).toContain('html body main #hosted-fld');
    }
    expect(hostedFieldsCss('https://example.test', true, false)).not.toContain('@font-face');
    expect(hostedFieldsCss('https://example.test', true, false)).toBe(hostedFieldsCss('http://localhost:3102', true));
  });
});

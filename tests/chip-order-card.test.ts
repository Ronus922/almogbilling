import { describe, expect, it } from 'vitest';
import { cardFailureMessage, cardHolderPhone, isValidIsraeliId, sdkSaysRefused } from '@/lib/chipOrders/card';

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

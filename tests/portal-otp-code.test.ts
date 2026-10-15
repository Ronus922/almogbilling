import { describe, expect, it } from 'vitest';
import { extractOtpCode } from '@/lib/portal/otpCode';

// The one place "what counts as the code" is decided for a paste, a
// clipboard-read button and the WebOTP callback alike (15/10/2026, "SMS
// ראשי, וואטסאפ גיבוי") — both messages the portal sends now carry other
// digits next to the code (the validity line, the WebOTP domain-binding
// trailer), so naive digit-stripping would concatenate them into garbage.
describe('extractOtpCode — the one run of six consecutive digits', () => {
  it('finds a bare code', () => {
    expect(extractOtpCode('482917')).toBe('482917');
  });

  it('finds the code inside the WhatsApp message, ignoring the "5 דקות" line', () => {
    const msg = [
      'קוד הכניסה שלך לפורטל בעלי הדירות:',
      '`482917`',
      '',
      'הקוד תקף ל-5 דקות.',
      'אם לא ביקשת קוד — התעלם מההודעה ופנה לחברת הניהול.',
    ].join('\n');
    expect(extractOtpCode(msg)).toBe('482917');
  });

  it('finds the code inside the SMS message, not the WebOTP domain-binding trailer', () => {
    const msg = [
      'קוד הכניסה שלך לפורטל בעלי הדירות:',
      '482917',
      '',
      'הקוד תקף ל-5 דקות.',
      '',
      '@almog-haifa.co.il #482917',
    ].join('\n');
    expect(extractOtpCode(msg)).toBe('482917');
  });

  it('survives a WhatsApp client prefixing the copy with a timestamp', () => {
    expect(extractOtpCode('[14:32, 15/10/2026] ALMOG CRM: קוד הכניסה שלך: 482917')).toBe('482917');
  });

  it('rejects a longer digit run rather than slicing it down to six', () => {
    expect(extractOtpCode('0541234567')).toBeNull(); // a phone number, not a code
    expect(extractOtpCode('מספר הדירה 1234567 קוד 482917')).toBe('482917');
  });

  it('rejects a shorter digit run', () => {
    expect(extractOtpCode('הקוד תקף ל-5 דקות בלבד')).toBeNull();
  });

  it('returns null for text with no clean six-digit run', () => {
    expect(extractOtpCode('')).toBeNull();
    expect(extractOtpCode('שלום, מה שלומך?')).toBeNull();
  });

  it('a custom digit count is respected (for callers that are not the 6-digit portal OTP)', () => {
    expect(extractOtpCode('12345', 5)).toBe('12345');
    expect(extractOtpCode('123456', 5)).toBeNull();
  });
});

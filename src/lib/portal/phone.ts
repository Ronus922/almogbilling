// E.164 for the owners portal. NOT a second phone normaliser: every rule lives
// in normalizePhone() (src/lib/whatsapp.ts) — the same gate the broadcasts use —
// and this module only adds the leading '+' and the mobile-only restriction.
//
// Why mobile-only for Israel: the code is delivered over WhatsApp, so a number
// that cannot receive one has no business on the roster. normalizePhone accepts
// a landline too, so the restriction has to be applied here.
//
// And why a PREFIX test rather than a length test: Israel's VoIP ranges (072,
// 073, 074, 076, 077) are ten digits locally, exactly like a mobile, so
// `972 + 9 digits` matches them as well — a length check would have let
// +972722592624 onto the roster. Only 05x is a mobile.
//
// Foreign numbers (decision 28/09/2026): a number written with a '+' and a
// non-Israeli country code is accepted as general E.164 (`^\+[1-9]\d{6,14}$`).
// No mobile/landline split exists for the whole world, so none is attempted —
// WhatsApp itself is the test, at send time.
//
// This is deliberately the SAME rule as the table's CHECK constraint
// (`^\+9725[0-9]{8}$` OR a non-972 `^\+[1-9][0-9]{6,14}$`, migration
// 20260928…_owner_phone_e164_international) and as normalizePhone's '+' branch:
// if the three ever disagree, a row can be created that the login can never
// match, or vice versa. tests/portal-phone.test.ts pins every case.
import { E164_DIGITS, normalizePhone } from '@/lib/whatsapp';

/** What the admin sees when a number fails toPortalE164 — the sheet and the
 *  route say the same thing. */
export const OWNER_PHONE_RULE_MESSAGE =
  'נדרש נייד ישראלי (05…) או מספר בינלאומי עם קידומת (+…) — הקוד נשלח בוואטסאפ';

/** Israeli MOBILE in E.164 — the only Israeli numbers the roster takes. */
const IL_MOBILE_E164 = /^\+9725\d{8}$/;

/**
 * Roster key.
 *   Israeli mobile, any spelling → '+9725XXXXXXXX'
 *     ('0541234567' / '+972-54-123-4567' / '972541234567' / '541234567').
 *   Foreign, written with '+' → E.164 verbatim ('+1 (415) 555-2671' → '+14155552671').
 *   null for an Israeli landline / VoIP, a foreign number without its '+',
 *   a '+972' that is not a mobile, or anything else.
 */
export function toPortalE164(raw: string | null | undefined): string | null {
  try {
    const { phone } = normalizePhone(raw);
    const e164 = `+${phone}`;
    if (phone.startsWith('972')) return IL_MOBILE_E164.test(e164) ? e164 : null;
    return E164_DIGITS.test(phone) ? e164 : null;
  } catch {
    return null;
  }
}

/** '+972541234567' → '0541234567'. For display and for tel: links. */
export function e164ToLocal(e164: string): string {
  return e164.startsWith('+972') ? `0${e164.slice(4)}` : e164;
}

/** '+972541234567' → '972541234567@c.us' — Green API's chat id. */
export function e164ToChatId(e164: string): string {
  return `${e164.replace(/^\+/, '')}@c.us`;
}

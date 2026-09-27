// E.164 for the owners portal. NOT a second phone normaliser: every rule lives
// in normalizePhone() (src/lib/whatsapp.ts) — the same gate the broadcasts use —
// and this module only adds the leading '+' and the mobile-only restriction.
//
// Why mobile-only: the code is delivered over WhatsApp, so a number that cannot
// receive one has no business on the roster. normalizePhone accepts a landline
// too, so the restriction has to be applied here.
//
// And why a PREFIX test rather than a length test: Israel's VoIP ranges (072,
// 073, 074, 076, 077) are ten digits locally, exactly like a mobile, so
// `972 + 9 digits` matches them as well — a length check would have let
// +972722592624 onto the roster. Only 05x is a mobile. This is deliberately the
// SAME rule as the migration's backfill (`^05\d{8}$`) and as the table's CHECK
// constraint (`^\+9725[0-9]{8}$`): if the three ever disagree, a row can be
// created that the login can never match, or vice versa.
import { normalizePhone } from '@/lib/whatsapp';

/** Israeli MOBILE → E.164: '0541234567' / '+972-54-123-4567' / '972541234567'
 *  → '+972541234567'. null for a landline, a VoIP number, or anything else. */
const IL_MOBILE_E164 = /^\+9725\d{8}$/;

export function toPortalE164(raw: string | null | undefined): string | null {
  try {
    const e164 = `+${normalizePhone(raw).phone}`;
    return IL_MOBILE_E164.test(e164) ? e164 : null;
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

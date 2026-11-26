// The contact card of /chip-order ("פרטי התקשרות") — 26/11/2026 (Ronen): the
// customer typed a name, phone and email in the first person row and then had
// to type the phone and email again in the contact card. A box, ticked by
// default, makes the contact details the first row's: the two inputs give way
// to a read-only line, and they follow every later edit of that row. Unticked,
// the inputs come back filled with the first row's values, free to change.
//
// Nothing changes on the server: the order still carries the orderer's phone
// and email exactly as before (the body of POST /api/public/chip-order).
//
// The rules stay the contact card's: an Israeli mobile, and an email — the
// receipt goes to it. So while the box is ticked the first row's email is
// required, and the problems of the contact details show on the first row's
// fields (the only place they can be fixed while the box is ticked).
import { z } from 'zod';
import { toPortalE164 } from '@/lib/portal/phone';

export interface ContactDetails {
  phone: string;
  email: string;
}

export const CONTACT_TEXT = {
  sameAsFirst: 'פרטי ההתקשרות זהים לפרטי השורה הראשונה',
  /** Before the read-only line: where the messages and the receipt go. */
  sentTo: 'העדכונים והקבלה יישלחו אל:',
  /** Next to the first row's email while the box is ticked. */
  emailNote: 'חובה — לשם תישלח הקבלה',
  emailRequired: 'נדרש מייל — אליו תישלח הקבלה',
  emailInvalid: 'כתובת מייל לא תקינה',
  phoneIsraeli: 'נדרש מספר טלפון נייד ישראלי',
  /** The first row's phone is valid for the row, but not as the contact phone. */
  phoneIsraeliSame: 'לפרטי ההתקשרות נדרש נייד ישראלי',
} as const;

export const isEmail = (v: string) => z.email().safeParse(v.trim().toLowerCase()).success;

/** The contact rules, by the field the message shows on: 'phone' / 'email'
 *  (the card's inputs), or — while the box is ticked — the first row's
 *  `phone_<key>` / `email_<key>`. */
export function contactErrors(contact: ContactDetails, sameAsFirst: boolean, firstRowKey: number | undefined): Record<string, string> {
  const onRow = sameAsFirst && firstRowKey !== undefined;
  const e: Record<string, string> = {};
  const e164 = toPortalE164(contact.phone);
  if (!e164 || !e164.startsWith('+9725')) {
    e[onRow ? `phone_${firstRowKey}` : 'phone'] = onRow ? CONTACT_TEXT.phoneIsraeliSame : CONTACT_TEXT.phoneIsraeli;
  }
  if (!isEmail(contact.email)) {
    e[onRow ? `email_${firstRowKey}` : 'email'] = onRow && !contact.email.trim() ? CONTACT_TEXT.emailRequired : CONTACT_TEXT.emailInvalid;
  }
  return e;
}

/** Where a problem the SERVER found in the contact details ('phone' / 'email'
 *  of the body) shows: the card's input, or the first row's while ticked. */
export function contactFieldKey(field: 'phone' | 'email', sameAsFirst: boolean, firstRowKey: number | undefined): string {
  return sameAsFirst && firstRowKey !== undefined ? `${field}_${firstRowKey}` : field;
}

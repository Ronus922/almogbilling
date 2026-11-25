// Chip orders — card payment: the pure part (types, the texts both sides
// show, and the checks that need no server). No 'server-only' here: the public
// order form imports it.

export type CardEnv = 'sandbox' | 'production';
export type CardStatus = 'started' | 'paid' | 'failed';

/** What /api/public/chip-order/payplus/session hands the browser: exactly what
 *  the processor's SDK needs to mount its fields, and nothing else. */
export interface CardSession {
  page_request_uid: string;
  hosted_fields_uuid: string;
  origin: string;
}

/** The answer of /api/public/chip-order/payplus/status. */
export type CardPaymentState = 'paid' | 'pending' | 'failed';

/** The strip of the order page in test mode when the payment step is the
 *  sandbox card (instead of "מצב בדיקה, אין חיוב"). */
export const CHIP_ORDER_TEST_CARD_BANNER = 'מצב בדיקה — תשלום בכרטיס בדיקה, אין חיוב אמיתי';

export const CARD_ENV_LABEL: Record<CardEnv, string> = {
  sandbox: 'סביבת בדיקות',
  production: 'אשראי',
};

/** Israeli ID number: 5–9 digits, left-padded to 9, Luhn-style check digit. */
export function isValidIsraeliId(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 9 || digits !== raw.trim()) return false;
  const id = digits.padStart(9, '0');
  if (/^0+$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

/** +9725XXXXXXXX → 9725XXXXXXXX: the form the processor wants for 3-D Secure
 *  (country code, no plus, no leading zero). */
export function cardHolderPhone(e164: string | null | undefined): string {
  return (e164 ?? '').replace(/\D/g, '');
}

// ── The processor's refusals, in Hebrew ────────────────────────────────────
// The SDK hands back the processor's own text, which is a code or English.
// What the customer reads is ours: a known code gets its own line, anything
// else the general one. The raw text is never shown.

const GENERAL_FAILURE = 'התשלום לא אושר. אפשר לבדוק את פרטי הכרטיס ולנסות שוב, או לנסות כרטיס אחר.';

const FAILURE_BY_CODE: [RegExp, string][] = [
  [/recaptcha/i, 'האימות האוטומטי („אני לא רובוט”) לא הושלם. יש לסמן את התיבה ולנסות שוב.'],
  [/expir/i, 'תוקף הכרטיס שגוי או שהכרטיס פג תוקף.'],
  [/cvv|cvc|security[-_ ]code/i, 'שלוש הספרות בגב הכרטיס (CVV) שגויות.'],
  [/card[-_ ]?holder[-_ ]?id|identification|id[-_ ]number/i, 'מספר תעודת הזהות של בעל הכרטיס שגוי.'],
  [/card[-_ ]?holder[-_ ]?name/i, 'נדרש שם בעל הכרטיס.'],
  [/card[-_ ]?holder[-_ ]?phone|phone/i, 'נדרש מספר טלפון תקין של בעל הכרטיס.'],
  [/credit[-_ ]?card[-_ ]?number|card[-_ ]?number|invalid[-_ ]?card|\bcc\b/i, 'מספר הכרטיס שגוי.'],
  [/insufficient|not[-_ ]sufficient|funds|limit/i, 'העסקה נדחתה על ידי חברת האשראי (מסגרת או יתרה). אפשר לנסות כרטיס אחר.'],
  [/3d|secure|authenticat/i, 'האימות מול חברת האשראי (3D Secure) לא הושלם. אפשר לנסות שוב.'],
  [/declin|reject|refus|denied|not[-_ ]approved/i, 'העסקה נדחתה על ידי חברת האשראי. אפשר לנסות שוב או לנסות כרטיס אחר.'],
];

/** A reply that says "refused" in words that do NOT rule a charge out (the
 *  gateway timed out, the network broke): the server is asked before anything
 *  is shown, and the customer is not told the card was not charged. */
const AMBIGUOUS = /timeout|timed[-_ ]out|network|unavailable|try[-_ ]again[-_ ]later|pending|in[-_ ]process/i;

/** The Hebrew line for a refused attempt, from whatever the SDK returned. */
export function cardFailureMessage(response: unknown): string {
  const all = replyTexts(response);
  for (const [re, he] of FAILURE_BY_CODE) if (re.test(all)) return he;
  return GENERAL_FAILURE;
}

/** Every text a reply of the SDK carries. */
function replyTexts(response: unknown): string {
  const texts: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v.trim()) texts.push(v); };
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    push(r.message); push(r.error); push(r.status_description);
    if (r.data && typeof r.data === 'object') {
      const d = r.data as Record<string, unknown>;
      push(d.message); push(d.status_description); push(d.status);
    }
    if (Array.isArray(r.errors)) {
      for (const e of r.errors) {
        if (typeof e === 'string') push(e);
        else if (e && typeof e === 'object') { push((e as Record<string, unknown>).message); push((e as Record<string, unknown>).field); }
      }
    }
  }
  return texts.join(' | ');
}

/**
 * Is the SDK's reply a DEFINITE refusal — the charge did not happen? Only an
 * explicit `success: false` whose text does not leave a charge open. Anything
 * else — a success, a shape this code does not know, a timeout — is NOT a
 * refusal: the page asks the server (which asks PayPlus) before it shows
 * anything, so an approved charge is never presented as "try again".
 * Either way the order turns paid on the server only, never from this.
 */
export function sdkSaysRefused(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  return r.success === false && !AMBIGUOUS.test(replyTexts(response));
}

export const CARD_TEXT = {
  idle: 'פרטי הכרטיס יוזנו בשלב הבא, אחרי אימות הטלפון.',
  loading: 'פותחים את שדות התשלום המאובטחים…',
  verifying: 'מאמתים את התשלום מול חברת הסליקה…',
  unverified: 'התשלום נשלח, אבל עדיין לא התקבל עליו אישור מחברת הסליקה. אין צורך לשלם שוב — ברגע שיגיע האישור תישלח אליך הודעה. אפשר גם לבדוק שוב בעוד רגע.',
  notCharged: 'חברת הסליקה מאשרת שהכרטיס לא חויב. אפשר לנסות לשלם שוב.',
  expired: 'חלון התשלום פג תוקף. הכרטיס לא חויב. אפשר לפתוח חלון תשלום חדש.',
  noAttempts: 'מספר ניסיונות התשלום הסתיים. הכרטיס לא חויב. אפשר לפתוח חלון תשלום חדש.',
  secure3d: 'נפתח חלון אימות של חברת האשראי (3D Secure). יש להשלים בו את האימות.',
  openFailed: 'לא ניתן לפתוח את התשלום כרגע. נסו שוב בעוד כמה דקות.',
  sdkFailed: 'שדות התשלום לא נטענו. בדקו את החיבור לאינטרנט ונסו שוב.',
  renew: 'פתיחת חלון תשלום חדש',
  nameRequired: 'נדרש שם בעל הכרטיס, כפי שמופיע על הכרטיס',
  idInvalid: 'מספר תעודת זהות לא תקין',
} as const;

// The text inside the processor's frames, matched to the form's own digit
// inputs (.cr-fld input.cr-num): Inter 600, tabular digits, #1a2233, the ghost
// placeholder, left-to-right — 16px on a phone and 14px from 621px, like the
// inputs. The box around the text is the page's (.cr-hf).
//
// What the real frame does with this text (read on the sandbox, 25/11/2026):
//   - it is parsed, re-printed and set as a <style> of the frame — with every
//     quotation mark turned into &#34;, which the browser then reads as an
//     invalid value and drops the whole declaration. So: NO quotation marks,
//     anywhere (family names bare, url() bare);
//   - the frame's own rule for the input is `html main #hosted-fld` (color,
//     padding, border); a weaker selector loses to it, so ours is longer;
//   - a media query inside a frame sees the FRAME's width, so the size is
//     decided here, from the page's width, when the fields are opened;
//   - the frame is another origin: it can use the page's font only through an
//     @font-face that names a URL answering with a CORS header — the card-font
//     route. Until that file arrives (or if it does not) the digits show in
//     the fallback family, same size and weight.
//
// The font is named only from a public https origin: the style travels in the
// frame's ADDRESS, and the filter in front of PayPlus answers 403 to an address
// that holds a localhost URL (seen 25/11/2026) — the frames then never load.
const FIELD = 'html body main #hosted-fld';
const PUBLIC_HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
export function hostedFieldsCss(pageOrigin: string, wide: boolean, withFont = true): string {
  const size = wide ? 14 : 16;
  const font = withFont && PUBLIC_HTTPS_ORIGIN.test(pageOrigin)
    ? `@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(${pageOrigin}/api/public/chip-order/card-font)}`
    : '';
  return [
    font,
    'html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}',
    'main{display:block;margin:0;padding:0;height:100%}',
    `${FIELD},${FIELD}:disabled{box-sizing:border-box;width:100%;height:100%;margin:0;padding:0 14px;border:0;outline:0;border-radius:0;background:transparent;box-shadow:none;-webkit-appearance:none;appearance:none;direction:ltr;text-align:left;font-family:Inter,Heebo,Arial,sans-serif;font-size:${size}px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:0;line-height:normal;color:#1a2233}`,
    `${FIELD}::placeholder{color:#b4bacb;font-weight:500;opacity:1}`,
    `${FIELD}:focus{outline:0;box-shadow:none}`,
  ].join('');
}

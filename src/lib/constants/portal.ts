// Owners portal ("פורטל בעלי דירות") — the fixed vocabulary and every tunable
// of the WhatsApp-OTP login. Isomorphic on purpose: the login screen counts the
// resend cooldown with the same constant the request route enforces, and the
// admin log renders the same event labels the routes write.
//
// The portal is a SEPARATE auth layer from the staff login: its own cookie, its
// own session table, its own guard. Nothing here touches src/lib/constants.ts.

/** Portal session cookie. Deliberately NOT the staff `almog_sid`: the staff
 *  cookie opens nothing under /portal, and this one opens nothing outside it. */
export const PORTAL_SESSION_COOKIE = 'portal_session';

/** Server-side session lifetime. The cookie itself carries no Max-Age, so the
 *  browser drops it when it closes — whichever comes first. */
export const PORTAL_SESSION_LIFETIME_HOURS = 12;

/** The code: 6 digits, valid 5 minutes, stored only as a bcrypt hash. */
export const PORTAL_OTP_DIGITS = 6;
export const PORTAL_OTP_TTL_MINUTES = 5;

/** No second code to the same phone before this many seconds. 45, aligned to
 *  the reference on 29/09/2026 (ref/otp-states.md "Resend cooldown 45s"); it
 *  was 60, which made the screen's timer and the server disagree. */
export const PORTAL_OTP_RESEND_COOLDOWN_SEC = 45;

/** Per-phone: this many code requests inside the window trigger a lockout. */
export const PORTAL_OTP_MAX_REQUESTS_PER_WINDOW = 5;
export const PORTAL_OTP_REQUEST_WINDOW_SEC = 15 * 60;

/**
 * Per-phone: this many wrong codes trigger a lockout (decision 29/09/2026 —
 * confirmed at 5, it was already 5 and never 3).
 *
 * It used to FEEL like two: the code boxes kept their digits after a wrong
 * code and re-submitted themselves on every keystroke of the correction, so
 * one honest retype spent four attempts. The count was right; the client was
 * spending it. Fixed in PortalOtpStep (the boxes clear on correction, exactly
 * as state 06 of ref/otp-states.md always said they should).
 */
export const PORTAL_OTP_MAX_ATTEMPTS = 5;

/** The resident is warned before the LAST attempt, so a lockout never arrives
 *  as a surprise (state 08). */
export function portalLastAttemptMessage(): string {
  return `ניסיון אחרון. קוד שגוי נוסף יחסום את הכניסה ל-${PORTAL_LOCKOUT_TIER_MINUTES[0]} דקות.`;
}

/** "הקוד שגוי. נותרו N ניסיונות." — the count comes from the server, so the
 *  screen can never disagree with what the next wrong code will actually do. */
export function portalWrongCodeMessage(attemptsLeft: number): string {
  return `הקוד שגוי. נותרו ${attemptsLeft} ניסיונות.`;
}

/** Per-IP ceiling on code requests (a plain 429 — an IP is never locked out).
 *  An IP is shared: a whole building behind one NAT, or a household. Locking it
 *  would let one abuser shut everyone else out, so it only ever throttles. */
export const PORTAL_OTP_MAX_PER_IP = 20;
export const PORTAL_OTP_IP_WINDOW_SEC = 60 * 60;

/** Per-IP ceiling on VERIFY attempts, derived rather than picked: an IP may ask
 *  for PORTAL_OTP_MAX_PER_IP codes in the window and each code allows
 *  PORTAL_OTP_MAX_ATTEMPTS guesses, so that product is the most a legitimate
 *  caller can need. Reusing the 20 would have cut the honest flow short.
 *  Its job is not to stop a break-in — the phone lockout does that — but to keep
 *  an anonymous caller from flooding portal_login_events once no live code
 *  exists, when every guess answers `code_expired` and nothing counts it. */
export const PORTAL_VERIFY_MAX_PER_IP = PORTAL_OTP_MAX_PER_IP * PORTAL_OTP_MAX_ATTEMPTS;

/** Escalating lockout durations, in minutes, by tier (1-based). */
export const PORTAL_LOCKOUT_TIER_MINUTES: readonly number[] = [30, 120, 24 * 60];

/** A repeat lockout inside this window escalates to the next tier. */
export const PORTAL_LOCKOUT_ESCALATION_WINDOW_HOURS = 24;

/** The manager gets ONE WhatsApp alert — on the third lockout of a phone
 *  within the escalation window, not on the first two. */
export const PORTAL_LOCKOUT_ALERT_TIER = 3;

/** Log retention intent. Nothing purges automatically in this slice — the
 *  number is recorded so a future job has one place to read it from. */
export const PORTAL_LOG_RETENTION_DAYS = 365;

// ── Copy shown to the resident ───────────────────────────────────────────────

/** Phone not on the roster / a tenant's phone / deactivated. Revealing that the
 *  number is not registered is a DELIBERATE decision — it sends the owner to
 *  the management company instead of leaving them guessing. */
export const PORTAL_NOT_OWNER_MESSAGE =
  'המספר אינו רשום כבעל דירה בבניין. פנה לחברת הניהול כדי לוודא שהטלפון שלך רשום במערכת.';


/** The words that send a resident to the management company. Every screen that
 *  shows such a message offers the contact details beside it (29/09/2026), so
 *  the test is on the copy itself rather than on a flag each call site has to
 *  remember to set — new copy is covered the day it is written. */
export const PORTAL_MANAGEMENT_COMPANY = 'חברת הניהול';

export function pointsAtManagementCompany(message: string | null | undefined): boolean {
  return Boolean(message && message.includes(PORTAL_MANAGEMENT_COMPANY));
}

/** Locked out. `minutes` is always rounded UP, so "0 דקות" can never show. */
export function portalLockedMessage(minutes: number): string {
  return `המספר נחסם זמנית עקב ניסיונות רבים. נסה שוב בעוד ${Math.max(1, Math.ceil(minutes))} דקות, או פנה לחברת הניהול.`;
}

/** The manager's WhatsApp alert on the third lockout within the window. */
export function portalLockoutAlertMessage(phoneE164: string): string {
  return `פורטל דיירים: המספר ${phoneE164} נחסם 3 פעמים ב-24 השעות האחרונות.`;
}

// ── The log's vocabulary ─────────────────────────────────────────────────────

export const PORTAL_EVENT_TYPES = [
  'code_requested',
  'code_sent',
  'send_failed',
  'code_invalid',
  'code_expired',
  'login_success',
  'phone_not_found',
  'phone_inactive',
  'locked_out',
  'unlocked_manually',
  'session_revoked',
] as const;

export type PortalEventType = (typeof PORTAL_EVENT_TYPES)[number];

/** Hebrew label per event — the "אירוע" column of both log screens. */
export const PORTAL_EVENT_LABEL: Record<PortalEventType, string> = {
  code_requested:    'בקשת קוד',
  code_sent:         'קוד נשלח',
  send_failed:       'שליחת קוד נכשלה',
  code_invalid:      'קוד שגוי',
  code_expired:      'קוד פג תוקף',
  login_success:     'התחברות הצליחה',
  phone_not_found:   'מספר לא רשום',
  phone_inactive:    'מספר מושבת',
  locked_out:        'נחסם',
  unlocked_manually: 'שוחרר ידנית',
  session_revoked:   'יציאה',
};

/** Tone per event for the log badge (DESIGN.md §10 tone families). */
export const PORTAL_EVENT_TONE: Record<PortalEventType, 'emerald' | 'rose' | 'amber' | 'slate' | 'blue'> = {
  code_requested:    'slate',
  code_sent:         'blue',
  send_failed:       'rose',
  code_invalid:      'amber',
  code_expired:      'amber',
  login_success:     'emerald',
  phone_not_found:   'rose',
  phone_inactive:    'rose',
  locked_out:        'rose',
  unlocked_manually: 'emerald',
  session_revoked:   'slate',
};

export const PORTAL_LOCKOUT_REASONS = ['too_many_invalid_codes', 'too_many_code_requests'] as const;
export type PortalLockoutReason = (typeof PORTAL_LOCKOUT_REASONS)[number];

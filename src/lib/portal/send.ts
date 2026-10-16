import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { e164ToChatId, toPortalE164 } from './phone';
import { webOtpDomain } from './otpChannel';
import { sendSms } from './sms';
import type { OtpChannel } from '@/lib/types/portal';
import { PORTAL_OTP_TTL_MINUTES, portalLockoutAlertMessage } from '@/lib/constants/portal';

// The portal's OTP send, over either live channel (15/10/2026, "SMS ראשי,
// וואטסאפ גיבוי"). WhatsApp goes through the BUILDING's existing Green API
// instance — getDefaultSendCreds() is the same system-send resolver the
// notification fan-out uses (prefers an authorized instance, else the
// oldest). No new instance, no new credential. SMS goes through
// src/lib/portal/sms.ts, not wired to a real provider yet — see there and
// docs/sms-provider.md.

/** SMS body: the code on its own line, and a LAST line in the exact shape
 *  Chrome's WebOTP API requires (`@<domain> #<code>`) so Android can fill it
 *  in without the resident touching the clipboard at all. That line must stay
 *  the final one, verbatim — anything after it and the browser stops matching. */
function smsMessage(code: string): string {
  return [
    'קוד הכניסה שלך לפורטל בעלי הדירות:',
    code,
    '',
    `הקוד תקף ל-${PORTAL_OTP_TTL_MINUTES} דקות.`,
    '',
    `@${webOtpDomain()} #${code}`,
  ].join('\n');
}

/** WhatsApp body: the code on its own line, wrapped in asterisks so WhatsApp
 *  renders it bold (16/10/2026 — monospace shrank the digits in WhatsApp's
 *  renderer for no benefit; bold keeps them full-size and still stands out
 *  from the surrounding sentence). */
function whatsappMessage(code: string): string {
  return [
    'קוד הכניסה שלך לפורטל בעלי הדירות:',
    `*${code}*`,
    '',
    `הקוד תקף ל-${PORTAL_OTP_TTL_MINUTES} דקות.`,
    'אם לא ביקשת קוד — התעלם מההודעה ופנה לחברת הניהול.',
  ].join('\n');
}

export type SendResult =
  | { ok: true; channel: OtpChannel }
  | { ok: false; error: string; channel: OtpChannel };

async function sendViaWhatsApp(phoneE164: string, code: string): Promise<SendResult> {
  const creds = await getDefaultSendCreds();
  if (!creds) return { ok: false, error: 'no_whatsapp_instance', channel: 'whatsapp' };
  try {
    await sendWhatsAppMessage({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId: e164ToChatId(phoneE164),
      message: whatsappMessage(code),
    });
    return { ok: true, channel: 'whatsapp' };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('[portal] code send failed (whatsapp)', { error });
    return { ok: false, error, channel: 'whatsapp' };
  }
}

async function sendViaSms(phoneE164: string, code: string): Promise<SendResult> {
  const res = await sendSms(phoneE164, smsMessage(code));
  if (res.ok) return { ok: true, channel: 'sms' };
  // No silent cross-channel fallback: the resident sees the failure and, if
  // they want, presses "שלח בוואטסאפ במקום" themselves — switching channel
  // without saying so would be confusing (a code arrives on the number but
  // not the app the screen just promised).
  logger.error('[portal] code send failed (sms)', { error: res.error });
  return { ok: false, error: res.error, channel: 'sms' };
}

/**
 * Sends the code over `channel`. The digits are passed in and used once —
 * they are never logged, not even on failure (the error carries the
 * transport's own message only).
 */
export async function sendPortalCode(phoneE164: string, code: string, channel: OtpChannel): Promise<SendResult> {
  return channel === 'sms' ? sendViaSms(phoneE164, code) : sendViaWhatsApp(phoneE164, code);
}

/**
 * One WhatsApp line to the manager, on the THIRD lockout of a phone inside the
 * escalation window. Best-effort and silent: a failed alert must never change
 * what the resident sees. Recipient: ADMIN_ALERT_PHONE (the same number the
 * failed-unit alerts go to), falling back to BLLINK_ALERT_PHONE as those
 * scripts do.
 */
export async function alertManagerAboutLockout(phoneE164: string): Promise<void> {
  const raw = env.ADMIN_ALERT_PHONE ?? env.BLLINK_ALERT_PHONE ?? null;
  const target = toPortalE164(raw);
  if (!target) {
    logger.warn('[portal] lockout alert skipped — ADMIN_ALERT_PHONE not set or not a mobile');
    return;
  }
  const creds = await getDefaultSendCreds();
  if (!creds) {
    logger.warn('[portal] lockout alert skipped — no WhatsApp instance connected');
    return;
  }
  try {
    await sendWhatsAppMessage({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId: e164ToChatId(target),
      message: portalLockoutAlertMessage(phoneE164),
    });
  } catch (err) {
    logger.error('[portal] lockout alert send failed', { err });
  }
}

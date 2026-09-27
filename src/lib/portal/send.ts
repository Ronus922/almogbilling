import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { e164ToChatId, toPortalE164 } from './phone';
import { PORTAL_OTP_TTL_MINUTES, portalLockoutAlertMessage } from '@/lib/constants/portal';

// The portal's two outbound WhatsApp messages, both through the BUILDING's
// existing Green API instance — getDefaultSendCreds() is the same system-send
// resolver the notification fan-out uses (prefers an authorized instance, else
// the oldest). No new instance, no new credential.

function codeMessage(code: string): string {
  return [
    `קוד הכניסה שלך לפורטל בעלי הדירות: ${code}`,
    '',
    `הקוד תקף ל-${PORTAL_OTP_TTL_MINUTES} דקות.`,
    'אם לא ביקשת קוד — התעלם מההודעה ופנה לחברת הניהול.',
  ].join('\n');
}

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Sends the code. The digits are passed in and used once — they are never
 * logged, not even on failure (the error carries Green API's message only).
 */
export async function sendPortalCode(phoneE164: string, code: string): Promise<SendResult> {
  const creds = await getDefaultSendCreds();
  if (!creds) return { ok: false, error: 'no_whatsapp_instance' };
  try {
    await sendWhatsAppMessage({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId: e164ToChatId(phoneE164),
      message: codeMessage(code),
    });
    return { ok: true };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('[portal] code send failed', { error });
    return { ok: false, error };
  }
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

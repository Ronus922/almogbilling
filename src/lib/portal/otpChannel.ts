import 'server-only';
import { env } from '@/env';
import type { OtpChannel } from '@/lib/types/portal';

export type { OtpChannel };

// Which transport carries the owner's OTP (15/10/2026, "SMS ראשי, וואטסאפ
// גיבוי"): SMS is the primary channel once configured, WhatsApp (Green API —
// the only live channel until now) is the explicit, resident-triggered
// fallback button.
//
// 019sms (src/lib/portal/sms.ts) is the wired provider. Until all four env
// vars below are set, isSmsConfigured() is false, resolveDefaultChannel()
// keeps returning 'whatsapp' exactly as before this existed, and "שלח
// בוואטסאפ במקום" simply never renders (it would offer the channel already
// in use).

export function isSmsConfigured(): boolean {
  return Boolean(env.SMS_PROVIDER && env.SMS_USERNAME && env.SMS_API_KEY && env.SMS_SENDER);
}

export function resolveDefaultChannel(): OtpChannel {
  return isSmsConfigured() ? 'sms' : 'whatsapp';
}

/**
 * The origin WebOTP's domain-binding line (`@<domain> #<code>`) must match
 * EXACTLY — Chrome compares it to the page's own origin and silently does
 * not autofill on any mismatch. Derived from APP_URL rather than a second,
 * separately-maintained config value, so staging and production each bind to
 * wherever they actually serve the portal from, and a future domain move
 * (billing.bios.co.il → almog-haifa.co.il, already done for the main app)
 * updates this for free.
 */
export function webOtpDomain(): string {
  return new URL(env.APP_URL).hostname;
}

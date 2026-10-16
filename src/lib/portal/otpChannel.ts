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

// Hostnames the portal is known to actually be reachable under. nginx
// currently 301s everything on billing.bios.co.il except /api/health and
// /api/webhooks/greenapi to almog-haifa.co.il (see the server block comment
// in sites-available/billing), so in practice the OTP request route only
// ever sees the primary domain — this allowlist exists so the derivation
// below stays correct if that routing ever changes, rather than relying on
// nginx policy as the only thing keeping the two in sync.
const WEBOTP_DOMAIN_ALLOWLIST = ['almog-haifa.co.il', 'billing.bios.co.il'];

/**
 * The origin WebOTP's domain-binding line (`@<domain> #<code>`) must match
 * EXACTLY — Chrome compares it to the page's own origin and silently does
 * not autofill on any mismatch. Derived from the ACTUAL request `Host` the
 * caller is serving (17/10/2026, round 3) rather than always the configured
 * APP_URL, and validated against an allowlist — an unrecognized or missing
 * host falls back to APP_URL's own hostname, never an unchecked header value.
 */
export function webOtpDomain(requestHost?: string | null): string {
  const fallback = new URL(env.APP_URL).hostname;
  const hostname = requestHost?.split(':')[0]?.toLowerCase();
  return hostname && WEBOTP_DOMAIN_ALLOWLIST.includes(hostname) ? hostname : fallback;
}

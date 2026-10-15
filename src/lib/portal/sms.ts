import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { isSmsConfigured } from './otpChannel';

export type SmsSendResult = { ok: true } | { ok: false; error: string };

/**
 * Sends one SMS. NOT WIRED TO A REAL PROVIDER YET (15/10/2026) — Ronen is
 * choosing between two Israeli transactional providers (docs/sms-provider.md)
 * and neither account exists. Until SMS_PROVIDER + SMS_API_KEY are both set
 * this always answers sms_not_configured, and the caller
 * (src/lib/portal/send.ts) never reaches it with a channel other than
 * 'whatsapp' in the first place — see otpChannel.ts#resolveDefaultChannel.
 *
 * Once an account exists: add that provider's concrete HTTP call here
 * (one function, swapped on env.SMS_PROVIDER — keep every provider adapter
 * this small and this isolated). Verify it against the provider's own
 * sandbox/test endpoint before the first real send: the only contract on
 * file right now (019 SMS, in docs/sms-provider.md) was scraped from public
 * docs and is missing a password/API-key field no SMS API actually goes
 * without — treat it as a starting point, not a tested integration.
 */
export async function sendSms(_phoneE164: string, _text: string): Promise<SmsSendResult> {
  if (!isSmsConfigured()) return { ok: false, error: 'sms_not_configured' };
  logger.error('[portal] SMS_PROVIDER is set but no adapter is implemented yet', { provider: env.SMS_PROVIDER });
  return { ok: false, error: 'sms_provider_not_implemented' };
}

import 'server-only';
import { env } from '@/env';
import { logger } from '@/lib/logger';
import { e164ToLocal } from './phone';
import { isSmsConfigured } from './otpChannel';
import {
  SMS_019_SEND_URL, buildProvider019RequestBody, describeProvider019Status, parseProvider019Response,
} from '@/lib/sms019';

export type SmsSendResult = { ok: true } | { ok: false; error: string };

/** docs.019sms.co.il — production send; there is no provider-side distinction
 *  between OTP and any other SMS, we just send raw text. `/api/test` (same
 *  shape, validates without sending) is for manual poking only — never from
 *  app code, or every "test" would be indistinguishable from a real send. */

/** Bounded so a stuck connection cannot pin the OTP request forever — the
 *  resident is staring at a spinner. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Sends one SMS through 019sms (shared request/response shape: src/lib/sms019.ts).
 */
export async function sendSms(phoneE164: string, text: string): Promise<SmsSendResult> {
  if (!isSmsConfigured()) return { ok: false, error: 'sms_not_configured' };

  const requestBody = buildProvider019RequestBody({
    username: env.SMS_USERNAME ?? '',
    source: env.SMS_SENDER ?? '',
    localPhone: e164ToLocal(phoneE164),
    message: text,
  });

  let res: Response;
  let raw: string;
  try {
    res = await fetch(SMS_019_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SMS_API_KEY}`, 'Content-Type': 'application/json' },
      body: requestBody,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (err) {
    // The real cause (DNS failure, our own timeout aborting, connection reset
    // — never a bare "fetch failed"), so an on-call reading the log knows
    // whether 019 is down or we are.
    const error = `019sms לא הגיב: ${(err as Error).message}`;
    logger.error('[portal] SMS send failed (network)', { error });
    return { ok: false, error };
  }

  if (!res.ok) {
    const error = `019sms HTTP ${res.status}: ${raw.slice(0, 200)}`;
    logger.error('[portal] SMS send failed (http)', { error });
    return { ok: false, error };
  }

  const parsed = parseProvider019Response(raw);
  if (!parsed) {
    const error = `019sms תשובה לא צפויה: ${raw.slice(0, 200)}`;
    logger.error('[portal] SMS send failed (bad response)', { error });
    return { ok: false, error };
  }

  if (parsed.status !== 0) {
    const error = `019sms (${parsed.status}): ${describeProvider019Status(parsed.status, parsed.message)}`;
    logger.error('[portal] SMS send rejected by provider', { status: parsed.status, error });
    return { ok: false, error };
  }

  return { ok: true };
}

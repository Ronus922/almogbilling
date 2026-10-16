import type { Pool } from 'pg';
import type { Recipient } from './types';
import { classifyError } from './errors';
import { persistFailure, releasePaced, type ProcessResult, type SendCreds } from './engine';
import { underRateLimit, recordSend } from './rate-limit';
import type { WaProvider } from './provider';
import type { SmsProvider } from './smsProvider';

// The SMS channel of a broadcast (16/10/2026, 019sms) — the same queue,
// worker, lease, retry policy and statuses as WhatsApp/email; the one thing
// genuinely new is the per-recipient fallback: 019 cannot reach every number
// (Israeli mobiles only) and can fail for reasons WhatsApp does not share
// (sender-ID verification, account credit), so a failed/ineligible SMS falls
// back to WhatsApp automatically instead of failing the recipient outright.
// No Next 'server-only' imports: this runs in the standalone worker.

export const SMS_RATE_SETTING_KEY = 'sms_rate_per_min';
/** OUR OWN conservative default (db/migrations/20261016163824) — 019
 *  publishes no per-minute throttle, only a 2500-recipient bulk cap. */
export const DEFAULT_SMS_RATE_PER_MIN = 20;
/** One shared bucket for the 019 account (a WhatsApp bucket is an instance
 *  id, so the two never mix in wa_send_log). */
export const SMS_RATE_BUCKET = 'sms';

/** The configured pace — any value outside 1..120 (same bounds as
 *  rate_per_min) or a missing row falls back to the default. */
export async function readSmsRatePerMin(pool: Pick<Pool, 'query'>): Promise<number> {
  const r = await pool.query<{ value: unknown }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [SMS_RATE_SETTING_KEY],
  );
  const n = Number(r.rows[0]?.value);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_SMS_RATE_PER_MIN;
}

/** phone_intl ('9725XXXXXXXX', no '+') → 019's local shape ('0XXXXXXXXX'),
 *  or null when it is not an Israeli mobile — 019 cannot deliver to it (no
 *  `includes_international` wiring here), so the caller falls back to
 *  WhatsApp instead of even trying. */
export function toIsraeliLocal(phoneIntl: string): string | null {
  return /^9725\d{8}$/.test(phoneIntl) ? `0${phoneIntl.slice(3)}` : null;
}

export interface SmsCreds { username: string; token: string; source: string }

export interface SmsProcessOpts {
  backoffBaseSec?: number;
}

/**
 * Send one claimed ('processing') SMS recipient, respecting the shared SMS
 * rate limit. On failure (ineligible phone or a rejected/undelivered send),
 * falls back to WhatsApp with the same text — never a second SMS attempt,
 * never attachments (the SMS channel carries none). sent_channel records
 * which one actually went out; a fallback also leaves a note in last_error
 * even though the recipient ends up 'sent', so the reason is not lost.
 *
 * The WhatsApp fallback is NOT gated on the WhatsApp rate bucket (it is
 * meant to be the exception, not the common case) but IS recorded there, so
 * concurrent WhatsApp campaigns sharing the same instance still see accurate
 * pacing. A deliberate simplification — see docs/sms-provider.md.
 */
export async function processSmsRecipient(
  pool: Pool,
  smsProvider: SmsProvider,
  smsCreds: SmsCreds,
  waProvider: WaProvider,
  waCreds: SendCreds,
  waBucket: string,
  item: Recipient,
  smsRatePerMin: number,
  opts: SmsProcessOpts = {},
): Promise<ProcessResult> {
  const base = { recipientId: item.id, campaignId: item.campaign_id };
  const backoff = opts.backoffBaseSec ?? 5;
  const fail = (cls: { errorClass: 'retryable' | 'auth' | 'invalid_phone' | 'invalid_payload' | 'permanent' | 'rate_limited' | 'indeterminate'; retryable: boolean; message: string }) =>
    persistFailure(pool, item, cls, null, backoff).then((outcome) => ({ ...base, outcome }));

  const live = await pool.query(
    `select 1 from public.wa_campaign_recipients where id=$1 and status='processing'`, [item.id]);
  if (!live.rowCount) return { ...base, outcome: 'failed' };

  if (!(await underRateLimit(pool, SMS_RATE_BUCKET, smsRatePerMin))) {
    await releasePaced(pool, item.id);
    return { ...base, outcome: 'paced' };
  }

  const attempted = await pool.query(
    `update public.wa_campaign_recipients set send_attempted_at=now() where id=$1 and status='processing'`, [item.id]);
  if (!attempted.rowCount) return { ...base, outcome: 'failed' };
  await recordSend(pool, SMS_RATE_BUCKET);

  const localPhone = toIsraeliLocal(item.phone_intl);
  let smsError: string;

  if (localPhone) {
    const res = await smsProvider.send({
      username: smsCreds.username, token: smsCreds.token, source: smsCreds.source,
      localPhone, message: item.payload,
    });
    if (res.ok) {
      await pool.query(
        `update public.wa_campaign_recipients
            set status='sent', provider_message_id=$2, sent_channel='sms', sent_at=now(),
                lease_expires_at=null, last_error=null, error_class=null
          where id=$1`,
        [item.id, res.providerMessageId],
      );
      return { ...base, outcome: 'sent' };
    }
    smsError = res.message;
  } else {
    smsError = 'אין מספר נייד ישראלי תקין ל-SMS';
  }

  const waRes = await waProvider.send({
    instanceId: waCreds.instanceId, token: waCreds.token, apiUrl: waCreds.apiUrl,
    chatId: item.chat_id, message: item.payload,
  });
  await recordSend(pool, waBucket);

  if (waRes.ok) {
    await pool.query(
      `update public.wa_campaign_recipients
          set status='sent', provider_message_id=$2, sent_channel='whatsapp', sent_at=now(),
              lease_expires_at=null, last_error=$3, error_class=null
        where id=$1`,
      [item.id, waRes.providerMessageId, `SMS נכשל (${smsError}) — נשלח בוואטסאפ במקום`],
    );
    return { ...base, outcome: 'sent' };
  }

  const cls = classifyError(new Error(waRes.message), { status: waRes.status, body: waRes.body });
  return fail({ ...cls, message: `SMS: ${smsError} | WhatsApp (גיבוי): ${cls.message}` });
}

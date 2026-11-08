import type { Pool } from 'pg';
import type { BroadcastChannel, Recipient } from './types';
import { classifyError } from './errors';
import { persistFailure, releasePaced, type ProcessResult, type SendCreds } from './engine';
import { underRateLimit, recordSend } from './rate-limit';
import type { WaProvider } from './provider';
import type { SmsProvider } from './smsProvider';

// The SMS channel of a broadcast (16/10/2026, 019sms) — the same queue,
// worker, lease, retry policy and statuses as WhatsApp/email. The one thing
// genuinely new is the OPTIONAL per-recipient fallback: 019 cannot reach every
// number (Israeli mobiles only) and can fail for reasons WhatsApp does not
// share (sender-ID verification, account credit).
//
// 08/11/2026: the fallback is an explicit per-campaign opt-in
// (wa_campaigns.sms_whatsapp_fallback, default false). It used to be automatic,
// and on 08/11 a broken compose form (it never sent channel='sms') plus that
// automatic fallback meant an SMS broadcast went out over the building's
// WhatsApp number to ~540 residents. Now a campaign without the flag has NO
// WhatsApp provider at all in the worker (SmsWhatsappFallback is null), so an
// SMS recipient that fails is simply 'failed' with 019's real reason.
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

/** The server's hard gate on the opt-in flag, independent of any UI: absent →
 *  false (the safe default); present → must be a boolean; true is accepted ONLY
 *  on an 'sms' campaign (the DB CHECK refuses it anywhere else too). */
export function parseSmsWhatsappFallback(
  channel: BroadcastChannel, raw: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: false };
  if (typeof raw !== 'boolean') return { ok: false, error: 'ערך גיבוי הוואטסאפ לא תקין' };
  if (raw && channel !== 'sms') return { ok: false, error: 'גיבוי בוואטסאפ זמין רק בתפוצת SMS' };
  return { ok: true, value: raw };
}

export interface SmsCreds { username: string; token: string; source: string }

/** The WhatsApp leg of an SMS recipient. Exists ONLY for a campaign that opted
 *  in (sms_whatsapp_fallback = true); the worker passes null otherwise, so
 *  processSmsRecipient has nothing to send over WhatsApp with. */
export interface SmsWhatsappFallback {
  provider: WaProvider;
  creds: SendCreds;
  /** The sending instance's rate window — the SAME bucket a WhatsApp broadcast
   *  on this instance counts against. */
  bucket: string;
  /** Recipients per minute this leg may add to that window (DEFAULT_WA_RATE_PER_MIN). */
  ratePerMin: number;
}

export interface SmsProcessOpts {
  backoffBaseSec?: number;
}

// A recipient whose SMS leg is finished but whose WhatsApp window was full is
// PARKED, not failed and not re-queued from scratch: re-claiming it must not
// send the SMS a second time. No column exists for that state (and none was
// added), so the row itself carries it — error_class 'rate_limited' plus a
// last_error that ends in this exact tail. The tail is unique to parking: a
// WhatsApp 429 from the provider also yields 'rate_limited', but its message
// is the provider's, so it never matches.
const WA_SLOT_NOTE = 'ממתין לתור הקצב של וואטסאפ';
const WA_PARK_TAIL = ` | WhatsApp (גיבוי): ${WA_SLOT_NOTE}`;
const SMS_ERROR_PREFIX = 'SMS: ';
const MAX_PARKED_SMS_ERROR = 300; // keep the whole marker well inside the 500-char log cap

/** The SMS-leg error a parked recipient carries, or null when the row is not a
 *  parked one (the SMS leg still has to run). */
export function parkedSmsError(item: Pick<Recipient, 'error_class' | 'last_error'>): string | null {
  if (item.error_class !== 'rate_limited') return null;
  const e = item.last_error ?? '';
  if (!e.startsWith(SMS_ERROR_PREFIX) || !e.endsWith(WA_PARK_TAIL)) return null;
  return e.slice(SMS_ERROR_PREFIX.length, e.length - WA_PARK_TAIL.length);
}

/** Hand the lease back and re-queue the recipient 2s later for the WhatsApp leg
 *  only (same pacing as engine.releasePaced: the attempt is not counted). The
 *  status guard keeps a campaign cancelled mid-flight cancelled. */
async function parkForWhatsappSlot(pool: Pool, recipientId: string, smsError: string): Promise<boolean> {
  const r = await pool.query(
    `update public.wa_campaign_recipients
        set status='pending', worker_id=null, lease_expires_at=null,
            processing_started_at=null, attempt_count = attempt_count - 1,
            next_attempt_at = now() + interval '2 seconds',
            last_error=$2, error_class='rate_limited'
      where id=$1 and status='processing'`,
    [recipientId, `${SMS_ERROR_PREFIX}${smsError.slice(0, MAX_PARKED_SMS_ERROR)}${WA_PARK_TAIL}`],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Send one claimed ('processing') SMS recipient, respecting the shared SMS
 * rate limit. ONE SMS attempt, never a retry (a timeout may still have been
 * delivered — a retry would double-send) and never attachments (the SMS
 * channel carries none).
 *
 * `fallback` null (the default for every campaign): a failed/ineligible SMS
 * ends the recipient as 'failed' with 019's real reason in last_error
 * (e.g. "019sms 515: …"); nothing is ever sent over WhatsApp.
 *
 * `fallback` set (the campaign opted in): the same text goes out over
 * WhatsApp instead. sent_channel records which one actually went out; a
 * fallback also leaves a note in last_error even though the recipient ends up
 * 'sent', so the reason is not lost. That leg is gated on the instance's
 * WhatsApp rate window exactly like a WhatsApp broadcast recipient (the same
 * bucket, so it shares the budget with any WhatsApp broadcast running on that
 * instance, and a full window defers the recipient — see parkedSmsError). The
 * SMS leg keeps its own pace and is never held back by a full WhatsApp window.
 * Until 08/11/2026 this leg was only recorded in the window, never gated, so
 * a run of failing SMS went out at the SMS pace (20/min) instead of 12/min on
 * a number that had already been blocked once — see docs/sms-provider.md.
 */
export async function processSmsRecipient(
  pool: Pool,
  smsProvider: SmsProvider,
  smsCreds: SmsCreds,
  fallback: SmsWhatsappFallback | null,
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

  // Parked on an earlier pass (SMS already failed, WhatsApp window was full):
  // the SMS leg is finished — never sent twice — so go straight to WhatsApp.
  const priorSmsError = fallback ? parkedSmsError(item) : null;
  let smsError: string;
  let localPhone: string | null = null;

  if (priorSmsError !== null) {
    smsError = priorSmsError;
  } else {
    if (!(await underRateLimit(pool, SMS_RATE_BUCKET, smsRatePerMin))) {
      await releasePaced(pool, item.id);
      return { ...base, outcome: 'paced' };
    }

    const attempted = await pool.query(
      `update public.wa_campaign_recipients set send_attempted_at=now() where id=$1 and status='processing'`, [item.id]);
    if (!attempted.rowCount) return { ...base, outcome: 'failed' };
    await recordSend(pool, SMS_RATE_BUCKET);

    localPhone = toIsraeliLocal(item.phone_intl);
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
  }

  if (!fallback) {
    // No opt-in: the SMS result is final. The reason is 019's own (code +
    // description), or the missing-mobile note — never a generic message.
    return fail({
      errorClass: localPhone ? 'permanent' : 'invalid_phone',
      retryable: false,
      message: `SMS: ${smsError}`,
    });
  }

  // The WhatsApp leg, gated like processRecipient (engine.ts) gates a WhatsApp
  // broadcast recipient: one unit of the instance's window. A full window parks
  // the recipient for a later pass instead of sending.
  if (!(await underRateLimit(pool, fallback.bucket, fallback.ratePerMin))) {
    const parked = await parkForWhatsappSlot(pool, item.id, smsError);
    return { ...base, outcome: parked ? 'paced' : 'failed' };
  }

  // Mark "about to send" and count it in the window BEFORE the network call (a
  // crash mid-send is then detectable, not a silent duplicate). On the parked
  // path the claim cleared send_attempted_at, so it is set here.
  const marked = await pool.query(
    `update public.wa_campaign_recipients set send_attempted_at=coalesce(send_attempted_at, now())
      where id=$1 and status='processing'`, [item.id]);
  if (!marked.rowCount) return { ...base, outcome: 'failed' };
  await recordSend(pool, fallback.bucket);

  const waRes = await fallback.provider.send({
    instanceId: fallback.creds.instanceId, token: fallback.creds.token, apiUrl: fallback.creds.apiUrl,
    chatId: item.chat_id, message: item.payload,
  });

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

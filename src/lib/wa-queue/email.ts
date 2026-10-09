import type { Pool } from 'pg';
import type { Recipient } from './types';
import type { CampaignAttachment, AttachmentReader } from './attachments';
import type { Classified } from './errors';
import { persistFailure, releasePaced, type ProcessResult } from './engine';
import { underRateLimit, recordSend } from './rate-limit';
import { isAuthFailure, isTransientSmtpError, type SmtpHandle } from '@/lib/email/smtp-core';
import { broadcastEmailTemplate } from '@/templates/email/broadcast';

// The EMAIL channel of a broadcast (09/10/2026) — the same queue, worker,
// lease, retry policy and statuses as WhatsApp; only the delivery differs:
// one email per recipient (a single To, never BCC) through the SMTP account
// in Settings → מייל, the campaign's files attached as real MIME parts, read
// server-side from the private bucket (never a public or signed URL).
// No Next 'server-only' imports: this runs in the standalone worker.

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

export type EmailSendResult =
  | { ok: true; messageId: string }
  | { ok: false; message: string; authFailure: boolean; transient: boolean };

export interface EmailTransport {
  readonly kind: 'smtp' | 'mock';
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** The real transport: the shared pooled SMTP transporter (smtp-core). */
export function smtpEmailTransport(get: () => Promise<SmtpHandle>): EmailTransport {
  return {
    kind: 'smtp',
    async send(message) {
      try {
        const { transporter, from } = await get();
        const info = await transporter.sendMail({ from, ...message });
        return { ok: true, messageId: String(info.messageId ?? '') };
      } catch (err) {
        const e = err as { message?: string; response?: string; responseCode?: number };
        const detail = e.response ?? e.message ?? String(err);
        return {
          ok: false,
          message: `smtp: ${detail}`.slice(0, 400),
          authFailure: isAuthFailure(err),
          transient: isTransientSmtpError(err),
        };
      }
    },
  };
}

/** No network — records every message; scriptable failures. Used by dry-run
 *  email broadcasts and the whole test suite, so no real email is ever sent. */
export class MockEmailTransport implements EmailTransport {
  readonly kind = 'mock' as const;
  readonly sent: EmailMessage[] = [];
  constructor(private readonly script: {
    /** address → forced failure */
    fail?: Record<string, { message: string; authFailure?: boolean; transient?: boolean }>;
  } = {}) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const forced = this.script.fail?.[message.to];
    if (forced) {
      return { ok: false, message: forced.message, authFailure: forced.authFailure ?? false, transient: forced.transient ?? false };
    }
    this.sent.push(message);
    return { ok: true, messageId: `mock-email-${this.sent.length}` };
  }
}

// ── Pace ──────────────────────────────────────────────────────────────────────

/** app_settings key of the email send pace (recipients per minute). */
export const EMAIL_RATE_SETTING_KEY = 'email_rate_per_min';
export const DEFAULT_EMAIL_RATE_PER_MIN = 30;
/** One shared rate bucket for the SMTP account (a WhatsApp bucket is an
 *  instance id, so the two never mix in wa_send_log). */
export const EMAIL_RATE_BUCKET = 'email';

/** The configured pace — any value outside 1..120 (the same bounds as
 *  rate_per_min) or a missing row falls back to the default. */
export async function readEmailRatePerMin(pool: Pick<Pool, 'query'>): Promise<number> {
  const r = await pool.query<{ value: unknown }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [EMAIL_RATE_SETTING_KEY],
  );
  const n = Number(r.rows[0]?.value);
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_EMAIL_RATE_PER_MIN;
}

// ── Send one recipient ────────────────────────────────────────────────────────

/** Hebrew operator-facing message for an SMTP auth rejection (the log). */
export const EMAIL_AUTH_FAILED_MESSAGE = 'אימות SMTP נדחה — יש לעדכן App Password בהגדרות מייל';

export interface EmailProcessOpts {
  /** The campaign's files in sort_order — attached to every email. */
  attachments?: CampaignAttachment[];
  readAttachment?: AttachmentReader;
  backoffBaseSec?: number;
  /** Public origin for the email footer. */
  site: string;
  /** Raised once per auth rejection — the existing throttled admin alert. */
  onAuthFailure?: () => Promise<void>;
}

/**
 * Send one claimed ('processing') email recipient, respecting the shared email
 * rate limit, and persist the outcome — the email twin of processRecipient.
 * The whole message (text + files) is one SMTP transaction, so there is no
 * partial progress to resume: provider_message_id holds the SMTP message id.
 *
 * An SMTP auth rejection fails this recipient AND every not-yet-attempted one
 * of the campaign at once (same 'auth' error), instead of presenting the wrong
 * App Password to Gmail once per recipient — the account would lock. After
 * the password is fixed, retry_failed re-queues them all.
 */
export async function processEmailRecipient(
  pool: Pool,
  transport: EmailTransport,
  item: Recipient,
  perMin: number,
  opts: EmailProcessOpts,
): Promise<ProcessResult> {
  const base = { recipientId: item.id, campaignId: item.campaign_id };
  const backoff = opts.backoffBaseSec ?? 5;
  const fail = (cls: Classified, label: string | null = null) =>
    persistFailure(pool, item, cls, label, backoff).then((outcome) => ({ ...base, outcome }));

  // A claimed item can be stopped while it waits in the batch — the auth
  // breaker below, or a cancel. Never send for a row that is no longer ours.
  const live = await pool.query(
    `select 1 from public.wa_campaign_recipients where id=$1 and status='processing'`, [item.id]);
  if (!live.rowCount) return { ...base, outcome: 'failed' };

  if (!(await underRateLimit(pool, EMAIL_RATE_BUCKET, perMin))) {
    await releasePaced(pool, item.id);
    return { ...base, outcome: 'paced' };
  }

  const attempted = await pool.query(
    `update public.wa_campaign_recipients set send_attempted_at=now() where id=$1 and status='processing'`, [item.id]);
  if (!attempted.rowCount) return { ...base, outcome: 'failed' };
  await recordSend(pool, EMAIL_RATE_BUCKET);

  if (!item.email) {
    return fail({ errorClass: 'invalid_payload', retryable: false, message: 'אין כתובת אימייל לנמען' });
  }

  const files = opts.attachments ?? [];
  const parts: EmailAttachment[] = [];
  for (const file of files) {
    if (!opts.readAttachment) {
      return fail({ errorClass: 'permanent', retryable: false, message: 'attachment reader not configured' }, file.original_name);
    }
    try {
      parts.push({ filename: file.original_name, content: await opts.readAttachment(file), contentType: file.mime_type });
    } catch (err) {
      // Storage blip — the next attempt reads it again.
      return fail({ errorClass: 'retryable', retryable: true, message: `attachment read failed: ${(err as Error).message}` }, file.original_name);
    }
  }

  const subject = (item.subject ?? '').trim();
  const rendered = broadcastEmailTemplate({ subject, body: item.payload, site: opts.site });
  const res = await transport.send({
    to: item.email, subject: rendered.subject, text: rendered.text, html: rendered.html, attachments: parts,
  });

  if (!res.ok) {
    if (res.authFailure) {
      await opts.onAuthFailure?.();
      const outcome = await fail({ errorClass: 'auth', retryable: false, message: EMAIL_AUTH_FAILED_MESSAGE });
      // Everyone still waiting — queued, or claimed in this batch but not yet
      // attempted — fails the same way (one wrong-password login, not N).
      await pool.query(
        `update public.wa_campaign_recipients
            set status='failed', failed_at=now(), lease_expires_at=null,
                last_error=$2, error_class='auth'
          where campaign_id=$1 and id <> $3
            and (status='pending' or (status='processing' and send_attempted_at is null))`,
        [item.campaign_id, EMAIL_AUTH_FAILED_MESSAGE, item.id],
      );
      return outcome;
    }
    return fail(res.transient
      ? { errorClass: 'retryable', retryable: true, message: res.message }
      : { errorClass: 'permanent', retryable: false, message: res.message });
  }

  await pool.query(
    `update public.wa_campaign_recipients
        set status='sent', provider_message_id=$2, sent_at=now(), attachments_sent=$3,
            lease_expires_at=null, last_error=null, error_class=null
      where id=$1`,
    [item.id, res.messageId, files.length],
  );
  return { ...base, outcome: 'sent' };
}

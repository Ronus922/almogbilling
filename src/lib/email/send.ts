import 'server-only';
import { getTransporter } from './transporter';
import { notifyAdminsOfSmtpAuthFailure } from './authAlert';
import { logger } from '@/lib/logger';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  messageId: string;
  attempts: number;
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ESOCKET',
  'EDNS',
  'EHOSTUNREACH',
]);

interface SmtpError {
  code?: string;
  responseCode?: number;
}

function asSmtpError(err: unknown): SmtpError | null {
  return err && typeof err === 'object' ? (err as SmtpError) : null;
}

/** Credentials rejected: nodemailer's EAUTH, or the SMTP 534/535 auth replies. */
export function isAuthFailure(err: unknown): boolean {
  const e = asSmtpError(err);
  if (!e) return false;
  if (e.code === 'EAUTH') return true;
  return e.responseCode === 534 || e.responseCode === 535;
}

function isTransient(err: unknown): boolean {
  const e = asSmtpError(err);
  if (!e) return false;
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  // SMTP 4xx → transient (greylisting, temp throttle); 5xx → permanent.
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) return true;
  return false;
}

/**
 * Send with up to 2 retries (3 attempts total) on transient errors.
 * Backoff: 1s before retry #1, 2s before retry #2.
 * Auth failures (EAUTH / 534 / 535) → raise the throttled, in-app-only admin
 * alert and throw immediately — a wrong App Password does not fix itself.
 * Other SMTP 5xx → throw immediately.
 * Every delivered message leaves one log line: recipient, subject, messageId,
 * attempts — never the body, never credentials.
 */
export async function sendWithRetry(args: SendArgs): Promise<SendResult> {
  const delays = [1000, 2000];
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const { transporter, from } = await getTransporter();
      const info = await transporter.sendMail({ from, ...args });
      const result: SendResult = { messageId: String(info.messageId ?? ''), attempts: attempt };
      logger.info('[email] sent', JSON.stringify({ to: args.to, subject: args.subject, ...result }));
      return result;
    } catch (err) {
      if (isAuthFailure(err)) {
        await notifyAdminsOfSmtpAuthFailure();
        throw err;
      }
      if (attempt > 2 || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    }
  }
}

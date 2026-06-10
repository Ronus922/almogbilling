import 'server-only';
import { getTransporter } from './transporter';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ESOCKET',
  'EDNS',
  'EHOSTUNREACH',
]);

function isTransient(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number } | null;
  if (!e) return false;
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  // SMTP 4xx → transient (greylisting, temp throttle); 5xx → permanent.
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) return true;
  return false;
}

/**
 * Send with up to 2 retries (3 attempts total) on transient errors.
 * Backoff: 1s before retry #1, 2s before retry #2.
 * Auth failures (EAUTH) and SMTP 5xx → throw immediately.
 */
export async function sendWithRetry(args: SendArgs): Promise<void> {
  const delays = [1000, 2000];
  let attempt = 0;
  while (true) {
    try {
      const { transporter, from } = await getTransporter();
      await transporter.sendMail({ from, ...args });
      return;
    } catch (err) {
      attempt++;
      if (attempt > 2 || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    }
  }
}

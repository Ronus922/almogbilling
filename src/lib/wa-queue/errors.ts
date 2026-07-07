import type { ErrorClass } from './types';

// Classify a send failure so the engine knows whether to retry. Conservative by
// design: an UNKNOWN error is treated as retryable (transient), never as a silent
// permanent drop — a genuinely permanent failure exhausts max_attempts and lands
// in 'failed' either way, but a transient blip must not be discarded.

const PERMANENT: ErrorClass[] = ['auth', 'invalid_phone', 'invalid_payload', 'permanent'];

export interface Classified {
  errorClass: ErrorClass;
  retryable: boolean;
  message: string;
}

export function classifyError(err: unknown, providerHint?: { status?: number; body?: string }): Classified {
  const message = err instanceof Error ? err.message : String(err);
  const text = `${message} ${providerHint?.body ?? ''}`.toLowerCase();
  const status = providerHint?.status;

  let errorClass: ErrorClass;
  if (status === 429 || /rate.?limit|too many requests|429/.test(text)) {
    errorClass = 'rate_limited';
  } else if (status === 401 || status === 403 || /unauthor|forbidden|invalid token|apitoken|instance.*not|quota/.test(text)) {
    errorClass = 'auth';
  } else if (/invalid.*(phone|chatid|recipient)|not.*whatsapp|number.*not|coril..chatid/.test(text)) {
    errorClass = 'invalid_phone';
  } else if (/message.*(empty|too long|invalid)|payload/.test(text)) {
    errorClass = 'invalid_payload';
  } else if (status !== undefined && status >= 400 && status < 500) {
    errorClass = 'permanent'; // other 4xx → provider rejected
  } else {
    errorClass = 'retryable'; // 5xx, network, timeout, unknown
  }

  return { errorClass, retryable: !PERMANENT.includes(errorClass), message };
}

/** Exponential backoff with jitter, in seconds. attempt is 1-based. */
export function backoffSeconds(attempt: number, baseSec = 5, capSec = 300): number {
  const exp = Math.min(capSec, baseSec * 2 ** Math.max(0, attempt - 1));
  // deterministic-free jitter is fine here (worker runtime, not a workflow):
  const jitter = Math.floor(Math.random() * Math.ceil(exp * 0.25));
  return Math.min(capSec, exp + jitter);
}

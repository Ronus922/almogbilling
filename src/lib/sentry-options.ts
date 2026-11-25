/**
 * Sentry init options for the server and edge runtimes, read from the
 * environment AT RUNTIME — the caller passes the whole `process.env` object.
 *
 * Why an object and not `process.env.SENTRY_DSN`: a member expression like that
 * can be replaced by a constant at build time (next.config.ts `env`, which is
 * exactly how build -IgR1z3qNw1lAfFNQmWic lost its whole init block on
 * 07/10/2026: built without a DSN → `if ("")` → minified away). A property read
 * on an object handed over at runtime cannot be inlined, so the DSN in
 * /etc/billing/billing.env takes effect on the next restart, with no rebuild.
 *
 * Opt-in, as before: no DSN (unset, empty or blank) → null → nothing is
 * initialised and nothing is sent. Empty strings count as unset everywhere,
 * like env.ts (`emptyStringAsUndefined`), so `SENTRY_ENVIRONMENT=` in the env
 * file falls back to NODE_ENV instead of reporting an empty environment.
 */
export interface SentryRuntimeEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  NODE_ENV?: string;
}

export interface SentryRuntimeOptions {
  dsn: string;
  environment: string | undefined;
  tracesSampleRate: number;
  sendDefaultPii: false;
}

export function sentryRuntimeOptions(env: SentryRuntimeEnv): SentryRuntimeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    sendDefaultPii: false,
  };
}

// ── Request data that must never leave the server ──────────────────────────
// The SDK's HTTP integration keeps the body of an incoming request (up to
// 10KB) on the request's scope and attaches it to every event sent while that
// request is handled — an error, a logger.error, a sampled transaction —
// whatever `sendDefaultPii` says. On the public chip-order API that body is
// PayPlus's callback (the card's expiry, its BIN, the holder's ID number), an
// order form, or an order's tracking token; and two of its headers are
// secrets of the flow: the test-link token and the callback's signature. For
// these paths the body and the two headers are dropped from the event before
// it is sent (25/11/2026).

const SCRUBBED_PATHS = ['/api/public/chip-order'];
const SCRUBBED_HEADERS = ['x-chip-order-test', 'hash'];

interface EventWithRequest {
  request?: { url?: string; data?: unknown; headers?: Record<string, unknown> };
}

/** `beforeSend` / `beforeSendTransaction`: the same event, without the request
 *  body and the two headers when the request was to one of the paths above. */
export function dropSensitiveRequestData<T extends EventWithRequest>(event: T): T {
  const req = event.request;
  if (!req) return event;
  let path = req.url ?? '';
  try {
    path = new URL(path, 'http://localhost').pathname;
  } catch {
    // Not a URL: matched as the text it is.
  }
  if (!SCRUBBED_PATHS.some((p) => path.includes(p))) return event;
  delete req.data;
  if (req.headers) {
    for (const name of Object.keys(req.headers)) {
      if (SCRUBBED_HEADERS.includes(name.toLowerCase())) delete req.headers[name];
    }
  }
  return event;
}

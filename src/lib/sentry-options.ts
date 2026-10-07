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

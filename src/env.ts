/**
 * Typed, validated environment — the only place that reads process.env for
 * server configuration. Import `env` from '@/env' in SERVER code (route
 * handlers, src/lib/**, workers). Never from a client component: server
 * variables are not available there and t3-env throws on access.
 *
 * Validation runs when the server starts (src/instrumentation.ts) and again
 * whenever this module is first imported; a missing/invalid variable aborts
 * the process with the list of offending names. Empty strings count as unset,
 * so a copied .env.example fails loudly instead of running half-configured.
 *
 * Skipped during `next build` (the build host does not have the runtime
 * secrets), under vitest (unit tests mock everything env-dependent) and when
 * SKIP_ENV_VALIDATION=1. Adding a variable = adding it here AND in .env.example.
 */
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

const optionalString = z.string().min(1).optional();
const optionalUrl = z.url().optional();
const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL');
const numeric = z.string().regex(/^\d+(\.\d+)?$/, 'must be a number').optional();

export const env = createEnv({
  server: {
    // ── required in every runtime ─────────────────────────────────────────
    DATABASE_URL: postgresUrl,
    APP_URL: z.url(),
    SETTINGS_ENC_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes'),

    // ── database (session pooler, used by scripts/check-*) ───────────────
    DIRECT_URL: postgresUrl.optional(),

    // ── app ───────────────────────────────────────────────────────────────
    INTERNAL_BASE_URL: optionalUrl,
    // Cron/webhook secrets: the routes fail closed (503/401) when unset.
    BILLING_CRON_SECRET: optionalString,
    CRM_CRON_SECRET: optionalString,
    GREEN_API_WEBHOOK_SECRET: optionalString,

    // ── Supabase storage (documents / media; "storage not configured" if unset)
    SUPABASE_SERVICE_ROLE_KEY: optionalString,

    // ── email: DB row wins, env is the fallback; transport overrides for e2e
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    SMTP_FROM_NAME: optionalString,
    SMTP_HOST: optionalString,
    SMTP_PORT: numeric,
    SMTP_REQUIRE_TLS: z.enum(['true', 'false']).optional(),

    // ── Google OAuth (login button disabled when unset) ───────────────────
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,

    // ── integrations ──────────────────────────────────────────────────────
    ANTHROPIC_API_KEY: optionalString,
    CRM_SYNC_URL: optionalUrl,
    CRM_DEBTORS_REST_URL: optionalUrl,
    CRM_DEBTORS_REST_KEY: optionalString,
    BLLINK_SYNC_MIN_ROWS: numeric,
    BLLINK_SYNC_MIN_FRACTION: numeric,
    CHROME_PATH: optionalString,

    // ── monitoring (all optional; unset = off) ────────────────────────────
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),
    SENTRY_DSN: optionalUrl,
    SENTRY_ENVIRONMENT: optionalString,
    SENTRY_TRACES_SAMPLE_RATE: numeric,
    SENTRY_ORG: optionalString,
    SENTRY_PROJECT: optionalString,
    SENTRY_AUTH_TOKEN: optionalString,
    HEALTHCHECK_REMINDERS_URL: optionalUrl,
    HEALTHCHECK_BACKUP_URL: optionalUrl,

    // ── backup (read by scripts/backup/*, validated here for completeness)
    RESTIC_REPOSITORY: optionalString,
    RESTIC_PASSWORD: optionalString,
    B2_ACCOUNT_ID: optionalString,
    B2_ACCOUNT_KEY: optionalString,
  },
  client: {
    // Storage host; read server-side only today, but NEXT_PUBLIC_ by name.
    NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
  emptyStringAsUndefined: true,
  skipValidation:
    process.env.SKIP_ENV_VALIDATION === '1' ||
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.NODE_ENV === 'test',
  onValidationError: (issues) => {
    const lines = issues.map((i) => `  - ${i.path?.join('.') || '(root)'}: ${i.message}`);
    process.stderr.write(`\n❌ Invalid environment variables (see .env.example):\n${lines.join('\n')}\n\n`);
    throw new Error(`Invalid environment variables: ${issues.map((i) => i.path?.join('.')).join(', ')}`);
  },
});

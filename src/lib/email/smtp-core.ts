import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { QueryResult, QueryResultRow } from 'pg';
import type { EncryptedBlob } from '@/lib/crypto/settings-cipher';
import { env } from '@/env';

// The SMTP pieces shared by the Next server (transporter.ts / send.ts /
// appSettings.ts) and the standalone delivery worker, which sends the email
// channel of a broadcast (src/lib/wa-queue/email.ts). No 'server-only' here:
// the worker runs under tsx outside Next and cannot load that package — so
// this file holds the logic and the server modules wrap it, rather than the
// worker carrying a second copy of the SMTP setup.

/** Anything that runs a parameterised query — a pg Pool, a PoolClient, or the
 *  app's shared pool (src/lib/db.ts getDbPool()). */
export interface SqlRunner {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export interface SmtpTransportBase {
  host: string;
  port: number;
  requireTLS: boolean;
}

/** Gmail by default. The three env overrides exist for the e2e environment,
 *  which points them at Mailpit (docker-compose.e2e.yml); production sets none. */
export function smtpTransportBase(): SmtpTransportBase {
  return {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT) || 587,
    requireTLS: env.SMTP_REQUIRE_TLS !== 'false',
  };
}

export interface SmtpSettings {
  user: string;
  pass: string;
  fromName: string;
}

interface SmtpRow {
  user: string;
  fromName: string;
  passEnc: EncryptedBlob;
}

/** app_settings key of the SMTP account (Settings → מייל). */
export const SMTP_SETTINGS_KEY = 'smtp';

/**
 * Resolve SMTP settings: the app_settings row wins, the SMTP_USER/SMTP_PASS env
 * pair is the fallback. Throws when neither yields user+pass — the caller treats
 * that as fatal. `decrypt` opens the stored App Password (AES-256-GCM under
 * SETTINGS_ENC_KEY) — injected because the server and the worker each own one.
 */
export async function resolveSmtpSettings(
  db: SqlRunner,
  decrypt: (blob: EncryptedBlob) => string,
): Promise<SmtpSettings> {
  const r = await db.query<{ value: SmtpRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [SMTP_SETTINGS_KEY],
  );
  const row = r.rows[0];
  if (row) {
    return { user: row.value.user, pass: decrypt(row.value.passEnc), fromName: row.value.fromName };
  }
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error('SMTP not configured: no DB row and SMTP_USER/SMTP_PASS env not set');
  }
  return { user, pass, fromName: env.SMTP_FROM_NAME ?? 'ALMOG CRM' };
}

export interface SmtpHandle {
  transporter: Transporter;
  from: string;
}

/**
 * A pooled nodemailer transporter, rebuilt only when the account changes (hash
 * of user + pass + fromName — a new App Password in Settings takes effect on
 * the next send, no restart). Concurrent first calls share one build.
 */
export function createSmtpTransporterCache(
  base: SmtpTransportBase,
  load: () => Promise<SmtpSettings>,
  onPoolError: (err: unknown) => void,
): () => Promise<SmtpHandle> {
  let cached: (SmtpHandle & { hash: string }) | undefined;
  let building: Promise<SmtpHandle & { hash: string }> | undefined;

  return async function get(): Promise<SmtpHandle> {
    const settings = await load();
    const hash = createHash('sha256')
      .update(`${settings.user}|${settings.pass}|${settings.fromName}`)
      .digest('hex');

    if (cached?.hash === hash) return { transporter: cached.transporter, from: cached.from };
    if (building) {
      const pending = await building;
      if (pending.hash === hash) return { transporter: pending.transporter, from: pending.from };
    }

    building = (async () => {
      if (cached) {
        try { cached.transporter.close(); } catch { /* idle pool */ }
      }
      const transporter = nodemailer.createTransport({
        host: base.host,
        port: base.port,
        secure: false,
        requireTLS: base.requireTLS,
        auth: { user: settings.user, pass: settings.pass },
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      transporter.on('error', onPoolError);
      const next = { transporter, from: `"${settings.fromName}" <${settings.user}>`, hash };
      cached = next;
      return next;
    })();

    try {
      const next = await building;
      return { transporter: next.transporter, from: next.from };
    } finally {
      building = undefined;
    }
  };
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

/** Network blips and SMTP 4xx (greylisting, temporary throttle) — worth a
 *  retry; SMTP 5xx and anything else are permanent. */
export function isTransientSmtpError(err: unknown): boolean {
  const e = asSmtpError(err);
  if (!e) return false;
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  if (typeof e.responseCode === 'number' && e.responseCode >= 400 && e.responseCode < 500) return true;
  return false;
}

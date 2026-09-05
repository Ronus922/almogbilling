import 'server-only';
import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { getSmtpSettings } from '@/lib/db/appSettings';
import { logger } from '@/lib/logger';

// Gmail by default. The three env overrides exist for the e2e environment,
// which points them at Mailpit (docker-compose.e2e.yml); production sets none.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_REQUIRE_TLS = process.env.SMTP_REQUIRE_TLS !== 'false';

interface CachedTransporter {
  transporter: Transporter;
  from: string;
  hash: string;
}

const g = globalThis as unknown as {
  _smtpCache?: CachedTransporter;
  _smtpBuilding?: Promise<CachedTransporter>;
};

export async function getTransporter(): Promise<{ transporter: Transporter; from: string }> {
  const settings = await getSmtpSettings();
  const hash = createHash('sha256')
    .update(`${settings.user}|${settings.pass}|${settings.fromName}`)
    .digest('hex');

  if (g._smtpCache?.hash === hash) {
    return { transporter: g._smtpCache.transporter, from: g._smtpCache.from };
  }
  if (g._smtpBuilding) {
    const cached = await g._smtpBuilding;
    if (cached.hash === hash) return { transporter: cached.transporter, from: cached.from };
  }

  g._smtpBuilding = (async () => {
    if (g._smtpCache) {
      try { g._smtpCache.transporter.close(); } catch { /* idle pool */ }
    }
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      requireTLS: SMTP_REQUIRE_TLS,
      auth: { user: settings.user, pass: settings.pass },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    transporter.on('error', (e) => logger.error('[smtp pool error]', e));
    const from = `"${settings.fromName}" <${settings.user}>`;
    const cached: CachedTransporter = { transporter, from, hash };
    g._smtpCache = cached;
    return cached;
  })();

  try {
    const cached = await g._smtpBuilding;
    return { transporter: cached.transporter, from: cached.from };
  } finally {
    g._smtpBuilding = undefined;
  }
}

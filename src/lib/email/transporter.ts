import 'server-only';
import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { getSmtpSettings } from '@/lib/db/appSettings';

/*
 * SMTP host / port / security come from env. Production: the Google Workspace
 * SMTP relay (smtp-relay.gmail.com, 587, STARTTLS), which authorises the
 * server's registered IP addresses — no password. Auth is sent only when the
 * settings carry a password (e.g. smtp.gmail.com / 465 / true + App Password).
 *
 * Why the relay: Google rejected App-Password logins from this server's IPv6
 * address (535 BadCredentials) while accepting IPv4, and Node picks an address
 * family per connection — so sends failed intermittently. The relay accepts
 * both registered addresses.
 *
 * Defaults keep the pre-relay behaviour when the env vars are absent.
 */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';

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
  if (!Number.isInteger(SMTP_PORT) || SMTP_PORT < 1 || SMTP_PORT > 65535) {
    throw new Error('SMTP not configured: SMTP_PORT is not a valid port');
  }
  const settings = await getSmtpSettings();
  const hash = createHash('sha256')
    .update(`${SMTP_HOST}|${SMTP_PORT}|${SMTP_SECURE}|${settings.user}|${settings.pass ?? ''}|${settings.fromName}`)
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
      secure: SMTP_SECURE,
      // Without full TLS, STARTTLS is mandatory — never plaintext.
      ...(SMTP_SECURE ? {} : { requireTLS: true }),
      // Auth only when a password exists; the relay authorises by IP.
      ...(settings.pass ? { auth: { user: settings.user, pass: settings.pass } } : {}),
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    transporter.on('error', (e) => console.error('[smtp pool error]', e));
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

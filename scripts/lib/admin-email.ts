// scripts/lib/admin-email.ts — the email half of the scheduled-job alerting.
//
// Sibling of scripts/lib/admin-alert.ts (WhatsApp). Same nodemailer, same SMTP
// account, same encrypted App Password out of public.app_settings — no new
// service and no second set of credentials.
//
// Why it does not import src/lib/email/send.ts: that module (and the
// transporter and appSettings behind it) is `server-only` and reads config
// through @t3-oss/env-nextjs, and a bare `tsx scripts/x.ts` process under
// systemd can load neither. The host/port/TLS defaults below are copied from
// src/lib/email/transporter.ts and must stay in step with it.
//
// One-shot by design: no pool, no retry. The process exists for the length of
// one alert, and WhatsApp is the redundancy if this channel is down.
//
// Transport only — the message itself is built by scripts/lib/unit-failure.ts.
//
// Recipient: ADMIN_ALERT_EMAIL. Unset = no email, reported in the return value
// rather than thrown — an alert that cannot be delivered must not become a
// second failure on top of the one being reported.
import nodemailer from 'nodemailer';
import type { Client, Pool, PoolClient } from 'pg';
import { decryptToken, type EncBlob } from './admin-alert';
import type { BuiltEmail } from './unit-failure';

type Q = Client | Pool | PoolClient;

/** Kept identical to src/lib/email/transporter.ts. Production sets none of
 *  these; the e2e environment points them at Mailpit. */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_REQUIRE_TLS = process.env.SMTP_REQUIRE_TLS !== 'false';

export interface AdminEmailResult {
  sent: boolean;
  /** Human-readable outcome for the caller's log — never contains the password. */
  detail: string;
}

/** The admin mailbox an alert goes to, or null when email alerting is off. */
export function adminAlertEmail(): string | null {
  const to = (process.env.ADMIN_ALERT_EMAIL ?? '').trim();
  return to === '' ? null : to;
}

interface SmtpRow {
  user: string;
  fromName: string;
  passEnc: EncBlob;
}

/** The same resolution order as src/lib/db/appSettings.ts getSmtpSettings():
 *  the DB row wins, the SMTP_USER/SMTP_PASS env pair is the fallback. */
async function smtpCredentials(db: Q): Promise<{ user: string; pass: string; fromName: string }> {
  const { rows } = await db.query<{ value: SmtpRow }>(
    `select value from public.app_settings where key = 'smtp' limit 1`,
  );
  const row = rows[0];
  if (row) {
    return { user: row.value.user, pass: decryptToken(row.value.passEnc), fromName: row.value.fromName };
  }
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error('SMTP not configured: no app_settings row and SMTP_USER/SMTP_PASS not set');
  return { user, pass, fromName: process.env.SMTP_FROM_NAME ?? 'ALMOG CRM' };
}

/** Sends one alert. Read-only against the database (SMTP credentials only). */
export async function sendAdminEmail(db: Q, mail: BuiltEmail): Promise<AdminEmailResult> {
  const to = adminAlertEmail();
  if (!to) return { sent: false, detail: 'ADMIN_ALERT_EMAIL not set — email alert skipped' };

  const { user, pass, fromName } = await smtpCredentials(db);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: SMTP_REQUIRE_TLS,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    const info = await transporter.sendMail({ from: `"${fromName}" <${user}>`, to, ...mail });
    return { sent: true, detail: `email alert sent to ${to} (messageId=${String(info.messageId ?? '')})` };
  } finally {
    transporter.close();
  }
}

import 'server-only';
import { query, queryOne } from '@/lib/db';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';

const SMTP_KEY = 'smtp';

interface SmtpRow {
  user: string;
  fromName: string;
  passEnc: EncryptedBlob;
}

export interface SmtpSettings {
  user: string;
  pass: string;
  fromName: string;
}

export interface SmtpSettingsPublic {
  fromEmail: string;
  fromName: string;
  hasPassword: boolean;
}

/** Thrown when caller-supplied input is invalid. Route layer maps to HTTP 400. */
export class AppSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSettingsValidationError';
  }
}

/**
 * Resolve SMTP settings: DB row wins, env vars are fallback.
 * Throws if neither yields user+pass — caller treats as fatal.
 */
export async function getSmtpSettings(): Promise<SmtpSettings> {
  const row = await queryOne<{ value: SmtpRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [SMTP_KEY],
  );
  if (row) {
    return {
      user: row.value.user,
      pass: decrypt(row.value.passEnc),
      fromName: row.value.fromName,
    };
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const fromName = process.env.SMTP_FROM_NAME ?? 'ALMOG CRM';
  if (!user || !pass) {
    throw new Error('SMTP not configured: no DB row and SMTP_USER/SMTP_PASS env not set');
  }
  return { user, pass, fromName };
}

/** Public, password-free view for the Settings UI. */
export async function getSmtpSettingsPublic(): Promise<SmtpSettingsPublic> {
  const row = await queryOne<{ value: SmtpRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [SMTP_KEY],
  );
  if (row) {
    return {
      fromEmail: row.value.user,
      fromName: row.value.fromName,
      hasPassword: true,
    };
  }
  return {
    fromEmail: process.env.SMTP_USER ?? '',
    fromName: process.env.SMTP_FROM_NAME ?? 'ALMOG CRM',
    hasPassword: Boolean(process.env.SMTP_PASS),
  };
}

interface UpdateArgs {
  user: string;
  fromName: string;
  /** Plain App Password (16 chars). If omitted, keep existing pass from DB; throws on first save. */
  pass?: string;
}

export async function updateSmtpSettings(args: UpdateArgs, updatedBy: string): Promise<void> {
  let passEnc: EncryptedBlob;

  if (args.pass) {
    passEnc = encrypt(args.pass);
  } else {
    const existing = await queryOne<{ value: SmtpRow }>(
      `select value from public.app_settings where key = $1 limit 1`,
      [SMTP_KEY],
    );
    if (!existing) {
      throw new AppSettingsValidationError('App Password is required on first save');
    }
    passEnc = existing.value.passEnc;
  }

  const value: SmtpRow = { user: args.user, fromName: args.fromName, passEnc };

  await query(
    `insert into public.app_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [SMTP_KEY, JSON.stringify(value), updatedBy],
  );
}

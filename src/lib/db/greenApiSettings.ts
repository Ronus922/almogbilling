import 'server-only';
import { randomBytes } from 'node:crypto';
import { query, queryOne } from '@/lib/db';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import type { GreenApiSettingsPublic } from '@/types/whatsapp';

// Green API credentials live in app_settings under key='green_api', exactly
// mirroring SMTP (key='smtp'): the token is AES-256-GCM-encrypted with the SAME
// helper the Gmail App Password uses (src/lib/crypto/settings-cipher.ts).

const GREEN_API_KEY = 'green_api';

interface GreenApiRow {
  instanceId: string;
  tokenEnc: EncryptedBlob;
  /** Bearer secret Green API echoes back on inbound webhook calls (phase 2).
   *  Plaintext: it only authorises calls INTO us, not the Green API account. */
  webhookToken?: string;
}

export interface GreenApiSettings {
  instanceId: string;
  token: string;
}

/** Thrown when caller-supplied input is invalid. Route layer maps to HTTP 400. */
export class GreenApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GreenApiValidationError';
  }
}

/** Thrown when no credentials are configured at all. Route maps to a real error. */
export class GreenApiNotConfiguredError extends Error {
  constructor(message = 'WhatsApp (Green API) לא הוגדר. הגדר חיבור בעמוד ההגדרות.') {
    super(message);
    this.name = 'GreenApiNotConfiguredError';
  }
}

/** Resolve full credentials (decrypted token). Throws if not configured. */
export async function getGreenApiSettings(): Promise<GreenApiSettings> {
  const row = await queryOne<{ value: GreenApiRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [GREEN_API_KEY],
  );
  if (!row || !row.value?.instanceId || !row.value?.tokenEnc) {
    throw new GreenApiNotConfiguredError();
  }
  return {
    instanceId: row.value.instanceId,
    token: decrypt(row.value.tokenEnc),
  };
}

/** Public, token-free view for the Settings UI. */
export async function getGreenApiSettingsPublic(): Promise<GreenApiSettingsPublic> {
  const row = await queryOne<{ value: GreenApiRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [GREEN_API_KEY],
  );
  if (row) {
    return {
      instanceId: row.value.instanceId ?? '',
      hasToken: Boolean(row.value.tokenEnc),
    };
  }
  return { instanceId: '', hasToken: false };
}

interface UpdateArgs {
  instanceId: string;
  /** Plain Green API token. If omitted, keep the existing one (throws on first save). */
  token?: string;
}

export async function updateGreenApiSettings(args: UpdateArgs, updatedBy: string): Promise<void> {
  let tokenEnc: EncryptedBlob;

  if (args.token) {
    tokenEnc = encrypt(args.token);
  } else {
    const existing = await queryOne<{ value: GreenApiRow }>(
      `select value from public.app_settings where key = $1 limit 1`,
      [GREEN_API_KEY],
    );
    if (!existing?.value?.tokenEnc) {
      throw new GreenApiValidationError('יש להזין טוקן בשמירה הראשונה');
    }
    tokenEnc = existing.value.tokenEnc;
  }

  // Preserve any existing webhookToken across credential updates.
  const prior = await queryOne<{ value: GreenApiRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [GREEN_API_KEY],
  );
  const value: GreenApiRow = { instanceId: args.instanceId, tokenEnc };
  if (prior?.value?.webhookToken) value.webhookToken = prior.value.webhookToken;

  await query(
    `insert into public.app_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update
       set value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [GREEN_API_KEY, JSON.stringify(value), updatedBy],
  );
}

/** Read-only fetch of the inbound webhook bearer token (null if not registered).
 *  Used by the public webhook route to authenticate Green API's calls. */
export async function getGreenApiWebhookToken(): Promise<string | null> {
  const row = await queryOne<{ value: GreenApiRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [GREEN_API_KEY],
  );
  return row?.value?.webhookToken ?? null;
}

/**
 * Return the webhook bearer token, generating + persisting one if absent.
 * Requires credentials to already exist (you can't register a webhook without an
 * instance). Called from the admin "enable inbound" registration flow.
 */
export async function ensureGreenApiWebhookToken(updatedBy: string): Promise<string> {
  const row = await queryOne<{ value: GreenApiRow }>(
    `select value from public.app_settings where key = $1 limit 1`,
    [GREEN_API_KEY],
  );
  if (!row || !row.value?.instanceId || !row.value?.tokenEnc) {
    throw new GreenApiNotConfiguredError();
  }
  if (row.value.webhookToken) return row.value.webhookToken;

  const webhookToken = randomBytes(24).toString('hex');
  const value: GreenApiRow = { ...row.value, webhookToken };
  await query(
    `update public.app_settings
        set value = $2::jsonb, updated_by = $3, updated_at = now()
      where key = $1`,
    [GREEN_API_KEY, JSON.stringify(value), updatedBy],
  );
  return webhookToken;
}

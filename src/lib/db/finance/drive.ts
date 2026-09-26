import 'server-only';
import { query, queryOne } from '@/lib/db';
import { encrypt, decrypt, type EncryptedBlob } from '@/lib/crypto/settings-cipher';
import type { DriveConnectionPublic } from '@/lib/types/finance';

export type { DriveConnectionPublic };

// The ONE Google account whose Drive receives the receipt backups
// (fin_drive_connection, id = 1). The refresh token is stored as the same
// AES-256-GCM blob the SMTP password and the Green API tokens use
// (SETTINGS_ENC_KEY) and only ever leaves this module decrypted into
// src/lib/finance/drive-client.ts.

interface ConnectionRow {
  email: string;
  refresh_token_enc: EncryptedBlob;
  root_folder_id: string | null;
  connected_at: string;
}

export async function getDriveConnectionPublic(): Promise<DriveConnectionPublic> {
  const row = await queryOne<{ email: string; connected_at: string }>(
    `select email, connected_at from public.fin_drive_connection where id = 1`,
  );
  return row
    ? { connected: true, email: row.email, connected_at: row.connected_at }
    : { connected: false, email: null, connected_at: null };
}

/** The decrypted credentials, or null when no account is connected. */
export async function getDriveCredentials(): Promise<{ email: string; refreshToken: string; rootFolderId: string | null } | null> {
  const row = await queryOne<ConnectionRow>(
    `select email, refresh_token_enc, root_folder_id, connected_at from public.fin_drive_connection where id = 1`,
  );
  if (!row) return null;
  return { email: row.email, refreshToken: decrypt(row.refresh_token_enc), rootFolderId: row.root_folder_id };
}

/** Replace the connection (a re-connect to another account resets the cached
 *  root folder — the folder lives in the previous account's Drive). */
export async function upsertDriveConnection(input: { email: string; refreshToken: string; connectedBy: string }): Promise<void> {
  const blob = encrypt(input.refreshToken);
  await query(
    `insert into public.fin_drive_connection (id, email, refresh_token_enc, root_folder_id, connected_at, connected_by)
     values (1, $1, $2::jsonb, null, now(), $3)
     on conflict (id) do update
       set email = excluded.email,
           refresh_token_enc = excluded.refresh_token_enc,
           root_folder_id = null,
           connected_at = now(),
           connected_by = excluded.connected_by`,
    [input.email, JSON.stringify(blob), input.connectedBy],
  );
}

export async function setDriveRootFolderId(folderId: string): Promise<void> {
  await query(`update public.fin_drive_connection set root_folder_id = $1 where id = 1`, [folderId]);
}

// scripts/lib/admin-alert.ts — the one WhatsApp alert path for scheduled jobs.
//
// Extracted from scripts/bllink-scrape.ts on 16/09/2026, when the nightly backup
// and the Storage garbage collector needed the same thing. Alongside the
// healthchecks.io ping in scripts/backup/pg-backup.sh this is the project's whole
// alerting story for cron-style work — deliberately no new service.
//
// It sends through billing's OWN Green API instance (public.whatsapp_instances),
// so an alert costs nothing extra and needs no credentials of its own.
//
// Why it does not use src/lib/crypto/settings-cipher.ts: that module is
// `server-only` and reads the key through @t3-oss/env-nextjs, and a bare
// `tsx scripts/x.ts` process can load neither. Same SETTINGS_ENC_KEY (32 bytes,
// base64), same aes-256-gcm blob, decrypted here from process.env.
//
// Recipient: ADMIN_ALERT_PHONE, falling back to BLLINK_ALERT_PHONE — the name it
// had while the scraper was the only caller, and still the one set on the server.
// Neither set = no alert, reported in the return value rather than thrown.
import { createDecipheriv } from 'node:crypto';
import type { Client, Pool, PoolClient } from 'pg';
import { normalizePhone } from '../../src/lib/whatsapp';
import { GreenApiProvider } from '../../src/lib/wa-queue/provider';

type Q = Client | Pool | PoolClient;

export interface EncBlob {
  iv: string;
  ct: string;
  tag: string;
}

export interface AdminAlertResult {
  sent: boolean;
  /** Human-readable outcome for the caller's log — never contains the token. */
  detail: string;
}

/** The admin phone an alert goes to, or null when alerting is not configured. */
export function adminAlertPhone(): string | null {
  const phone = (process.env.ADMIN_ALERT_PHONE ?? process.env.BLLINK_ALERT_PHONE ?? '').trim();
  return phone === '' ? null : phone;
}

export function decryptToken(blob: EncBlob): string {
  const raw = process.env.SETTINGS_ENC_KEY;
  if (!raw) throw new Error('SETTINGS_ENC_KEY is not set (fail-closed)');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_ENC_KEY must decode to 32 bytes');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
}

/**
 * Sends `text` to the admin over WhatsApp. Read-only against the database (it
 * only looks up the instance credentials).
 *
 * A missing phone or a missing instance is NOT an error — an alert that cannot
 * be delivered must not turn into a second failure on top of the one being
 * reported. Both come back as `{ sent: false }` with the reason.
 */
export async function sendAdminAlert(db: Q, text: string): Promise<AdminAlertResult> {
  const phone = adminAlertPhone();
  if (!phone) return { sent: false, detail: 'ADMIN_ALERT_PHONE / BLLINK_ALERT_PHONE not set — alert skipped' };

  const { rows } = await db.query<{ green_instance_id: string; green_token_enc: EncBlob; api_url: string }>(
    `select green_instance_id, green_token_enc, api_url
       from public.whatsapp_instances
      order by (state = 'authorized') desc, created_at asc
      limit 1`,
  );
  const inst = rows[0];
  if (!inst) return { sent: false, detail: 'no whatsapp_instances row — alert skipped' };

  const { chatId } = normalizePhone(phone);
  const result = await new GreenApiProvider().send({
    instanceId: inst.green_instance_id,
    token: decryptToken(inst.green_token_enc),
    apiUrl: inst.api_url,
    chatId,
    message: text,
  });
  return result.ok
    ? { sent: true, detail: `WhatsApp alert sent (idMessage=${result.providerMessageId})` }
    : { sent: false, detail: `WhatsApp alert FAILED: ${result.message}` };
}

import 'server-only';
import { StorageClient } from '@supabase/storage-js';
import { appUrl } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * THE single chokepoint for Supabase Storage access.
 *
 * SECURITY INVARIANT: no function in the codebase may hand the client a URL that
 * points at the storage host. Files are served exclusively through the
 * authenticated proxy at /api/files/<bucket>/<path>, which re-checks the session
 * and the module permission on every request. A signed URL cannot do that — it is
 * a bearer token: whoever holds the link opens the file, logged in or not.
 *
 * Therefore this module is the ONLY place allowed to mention the storage host,
 * `storage/v1`, `createSignedUrl` or `getPublicUrl`. scripts/guard-no-storage-leak.sh
 * fails the build if any of those appear anywhere else under src/.
 *
 * Two URL builders, both pointing at the app origin and never at the storage host:
 *   buildProxyUrl        → /api/files/...          (session + permission required)
 *   buildPublicWaMediaUrl→ /api/public/wa-media/...(unauthenticated: Green API fetches it)
 */

export const PRIVATE_BUCKETS = ['supplier-documents', 'documents', 'issue-attachments'] as const;
export type PrivateBucket = (typeof PRIVATE_BUCKETS)[number];

/** The public bucket — served by /api/public/wa-media, not by /api/files. */
export const WHATSAPP_MEDIA_BUCKET = 'whatsapp-media';

export function getStorage(): StorageClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_storage_not_configured');
  return new StorageClient(`${url.replace(/\/$/, '')}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

// ─────────────────────────────────────────────────────────────────────
// The only URL builder. Relative by construction.
// ─────────────────────────────────────────────────────────────────────

/**
 * The in-app URL for a stored object: always relative, always behind the session
 * + permission check of /api/files. The browser resolves it against the app
 * origin (billing.bios.co.il), so the storage host never reaches the client.
 *
 * The runtime assertion below is a safety net, not decoration: if a future edit
 * ever makes this return an absolute or host-bearing URL, the request dies here
 * rather than leaking.
 */
export function buildProxyUrl(bucket: PrivateBucket, path: string): string {
  const url = `/api/files/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (/^https?:/i.test(url) || url.includes('bios.co.il')) {
    logger.error(`STORAGE LEAK BLOCKED: buildProxyUrl produced ${url}`);
    throw new Error('STORAGE LEAK BLOCKED');
  }
  return url;
}

// ─────────────────────────────────────────────────────────────────────
// Server-side object operations. None of these return an external URL.
// ─────────────────────────────────────────────────────────────────────

export async function uploadObject(
  bucket: string,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await getStorage().from(bucket).upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
}

/** Removes objects (best-effort; the DB row is authoritative). */
export async function deleteObjects(bucket: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await getStorage().from(bucket).remove(paths);
  } catch {
    // swallow — orphaned objects are harmless
  }
}

/** Raw object bytes, or null when the object is missing / unreadable. */
export async function getObjectStream(bucket: string, path: string): Promise<Blob | null> {
  const { data, error } = await getStorage().from(bucket).download(path);
  if (error || !data) return null;
  return data;
}

/**
 * Absolute URL for an outbound WhatsApp attachment, on OUR origin.
 *
 * It must be absolute and unauthenticated because Green API's servers fetch it
 * with no session of ours — that is why /api/public/wa-media exists and why this
 * is the only builder that emits an absolute URL. It points at the app, never at
 * the storage host. The same URL is stored in chat_messages.media_url and
 * rendered by the inbox, which resolves it same-origin.
 *
 * The assertion is a safety net: if the base ever resolves to the storage host,
 * the request dies here rather than leaking it to a WhatsApp recipient.
 */
export function buildPublicWaMediaUrl(path: string): string {
  const base = appUrl().replace(/\/$/, '');
  const url = `${base}/api/public/wa-media/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (url.includes('db.bios.co.il') || url.includes('/storage/v1')) {
    logger.error(`STORAGE LEAK BLOCKED: buildPublicWaMediaUrl produced ${url}`);
    throw new Error('STORAGE LEAK BLOCKED');
  }
  return url;
}

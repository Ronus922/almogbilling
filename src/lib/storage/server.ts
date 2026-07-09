import 'server-only';
import { StorageClient } from '@supabase/storage-js';

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
 * The one sanctioned exception is publicUrlForWhatsAppMedia — see its doc comment.
 */

export const PRIVATE_BUCKETS = ['supplier-documents', 'documents', 'issue-attachments'] as const;
export type PrivateBucket = (typeof PRIVATE_BUCKETS)[number];

/** The public bucket. NOT reachable through the proxy — see publicUrlForWhatsAppMedia. */
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
    console.error(`STORAGE LEAK BLOCKED: buildProxyUrl produced ${url}`);
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
 * SANCTIONED EXCEPTION — the whatsapp-media bucket is public on purpose: Green
 * API's servers fetch the file over plain HTTP with no session of ours, so an
 * authenticated proxy URL would be unreachable to them and outbound media would
 * break. This URL is handed to Green API, never rendered into our own pages.
 *
 * Consequence, accepted knowingly: the storage host is visible to Green API and
 * to the WhatsApp recipient. Closing that would need a separate unauthenticated
 * public route on the app origin.
 */
export function publicUrlForWhatsAppMedia(path: string): string {
  const { data } = getStorage().from(WHATSAPP_MEDIA_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

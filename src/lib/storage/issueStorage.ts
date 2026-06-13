import 'server-only';
import { randomUUID } from 'node:crypto';
import { StorageClient } from '@supabase/storage-js';

/**
 * Issue-image storage on the self-hosted Supabase Storage (db.bios.co.il).
 * Uses StorageClient directly (not the full supabase-js client) so it runs on
 * Node without the realtime WebSocket dependency — same pattern as
 * supplierStorage.ts.
 *
 * Bucket is PRIVATE: issues.images stores the object PATH (not a public URL);
 * the API issues short-lived signed URLs for viewing, so images stay behind the
 * issues:view permission. No secrets are exposed in any returned path.
 */

const BUCKET = 'issue-attachments';
const SIGNED_URL_TTL_SEC = 60 * 60; // 1 hour

function getStorage(): StorageClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_storage_not_configured');
  return new StorageClient(`${url.replace(/\/$/, '')}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

/**
 * Sanitise the original filename: keep word chars / dot / dash / Hebrew, collapse
 * everything else to '_'. Strips any path component (no '/', no '..'), so the
 * stored object key can never traverse outside the issue's prefix.
 */
function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name; // drop any directory part
  return base.replace(/[^\w.\-֐-׿]+/g, '_').replace(/\.+/g, '.').slice(0, 120) || 'image';
}

/** Uploads a file under <issueId>/<uuid>-<name>. Returns the storage path. */
export async function uploadIssueImage(
  issueId: string,
  file: File,
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  const storage = getStorage();
  const path = `${issueId}/${randomUUID()}-${safeName(file.name)}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error } = await storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
  return { path, sizeBytes: buffer.byteLength, mimeType: file.type || '' };
}

/** Short-lived signed URL for a stored object path (null if it cannot be signed). */
export async function signedUrlForIssueImage(path: string): Promise<string | null> {
  try {
    const { data, error } = await getStorage().from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/** Removes objects from storage (best-effort; the DB row is authoritative). */
export async function removeIssueImages(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await getStorage().from(BUCKET).remove(paths);
  } catch {
    // swallow — orphaned objects are harmless; the issue row is the source of truth
  }
}

/**
 * Guard: a stored image path MUST live under the given issue's prefix
 * (`<issueId>/...`). Defends every image mutation against a forged path that
 * points at another issue's objects.
 */
export function isPathUnderIssue(path: string, issueId: string): boolean {
  return typeof path === 'string' && path.startsWith(`${issueId}/`) && !path.includes('..');
}

import 'server-only';
import { randomUUID } from 'node:crypto';
import { StorageClient } from '@supabase/storage-js';

/**
 * Supplier-document storage on the self-hosted Supabase Storage (db.bios.co.il).
 * Uses StorageClient directly (not the full supabase-js client) so it runs on
 * Node 20 without the realtime WebSocket dependency.
 *
 * Bucket is PRIVATE: file_url stores the object PATH (not a public URL); the
 * documents API issues short-lived signed URLs for viewing, so documents stay
 * behind the suppliers:view permission.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error and the rest of the module is unaffected.
 */

const BUCKET = 'supplier-documents';
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

function safeName(name: string): string {
  return name.replace(/[^\w.\-֐-׿]+/g, '_').slice(0, 120) || 'file';
}

/** Uploads a file under <supplierId>/<uuid>-<name>. Returns the storage path. */
export async function uploadSupplierFile(
  supplierId: string,
  file: File,
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  const storage = getStorage();
  const path = `${supplierId}/${randomUUID()}-${safeName(file.name)}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error } = await storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
  return { path, sizeBytes: buffer.byteLength, mimeType: file.type || '' };
}

/** Short-lived signed URL for a stored object path (null if it cannot be signed). */
export async function signedUrlForPath(path: string): Promise<string | null> {
  try {
    const { data, error } = await getStorage().from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SEC);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/** Removes the object from storage (best-effort; row deletion is authoritative). */
export async function removeSupplierFile(path: string): Promise<void> {
  try {
    await getStorage().from(BUCKET).remove([path]);
  } catch {
    // swallow — the DB row delete is the source of truth; orphaned objects are harmless
  }
}

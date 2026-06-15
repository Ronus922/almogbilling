import 'server-only';
import { randomUUID } from 'node:crypto';
import { StorageClient } from '@supabase/storage-js';

/**
 * Generic document storage on the self-hosted Supabase Storage (db.bios.co.il).
 * Mirrors supplierStorage.ts: uses StorageClient directly (not the full
 * supabase-js client) so it runs on Node without the realtime WebSocket dep.
 *
 * Bucket is PRIVATE: storage_path stores the object PATH (not a public URL); the
 * documents API issues short-lived signed URLs for viewing, so files stay behind
 * the documents:view permission.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error ('supabase_storage_not_configured') and the rest of the module is
 * unaffected.
 */

const BUCKET = 'documents';
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

/**
 * Builds an organized object prefix:
 *   - entity-attached → "<entity_type>/<entity_id>"
 *   - foldered        → "folder/<folder_id>"
 *   - otherwise       → "unfiled"
 * (Pure path-building; never throws.)
 */
function buildPrefix(opts: {
  entityType?: string | null;
  entityId?: string | null;
  folderId?: string | null;
}): string {
  if (opts.entityType && opts.entityId) {
    return `${safeName(opts.entityType)}/${safeName(opts.entityId)}`;
  }
  if (opts.folderId) return `folder/${safeName(opts.folderId)}`;
  return 'unfiled';
}

/**
 * Best-effort bucket creation. Self-hosted Storage 404s on a missing bucket;
 * creating it on first upload removes a manual ops step. Swallows
 * "already exists" so it is idempotent.
 */
async function ensureBucket(storage: StorageClient): Promise<void> {
  try {
    const { error } = await storage.createBucket(BUCKET, { public: false });
    if (error && !/exist/i.test(error.message)) {
      // Non-"already exists" error — surface it; upload would fail anyway.
      throw new Error(`storage_bucket_unavailable: ${error.message}`);
    }
  } catch (err) {
    // createBucket can reject (e.g. 409 conflict) when the bucket exists —
    // treat conflicts as success, re-throw anything else.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/exist|409|conflict/i.test(msg)) throw err;
  }
}

/** Uploads a file under <prefix>/<uuid>-<name>. Returns the storage path. */
export async function uploadDocumentFile(
  file: File,
  opts: { entityType?: string | null; entityId?: string | null; folderId?: string | null },
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  const storage = getStorage();
  await ensureBucket(storage);
  const path = `${buildPrefix(opts)}/${randomUUID()}-${safeName(file.name)}`;
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
    const { data, error } = await getStorage()
      .from(BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEC);
    if (error || !data) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/** Removes the object from storage (best-effort; row state is authoritative). */
export async function removeDocumentFile(path: string): Promise<void> {
  try {
    await getStorage().from(BUCKET).remove([path]);
  } catch {
    // swallow — the DB row is the source of truth; orphaned objects are harmless
  }
}

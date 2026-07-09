import 'server-only';
import { randomUUID } from 'node:crypto';
import type { StorageClient } from '@supabase/storage-js';
import { buildProxyUrl, getStorage, getObjectStream, uploadObject, deleteObjects } from './server';

/**
 * Generic document storage. All Storage access goes through ./server.ts — this
 * module never touches the storage host or a signed URL.
 *
 * Bucket is PRIVATE: storage_path stores the object PATH (not a URL). Files are
 * served only through /api/files/documents/<path>, which enforces the documents /
 * debtor-documents permissions on every request.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error ('supabase_storage_not_configured') and the rest of the module is
 * unaffected.
 */

const BUCKET = 'documents';

/**
 * Storage object keys must be ASCII — Supabase Storage rejects non-ASCII keys
 * with "Invalid key". Keep only [A-Za-z0-9._-]; drop everything else. NEVER use
 * a user-supplied (possibly Hebrew) file name to build a key — the readable name
 * lives in documents.file_name, separate from storage_path.
 */
function asciiSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '');
}

/** ASCII file extension (lowercased, with the dot) or '' — derived from a name. */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim());
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * Builds an organized, ASCII-only object prefix:
 *   - entity-attached → "<entity_type>/<entity_id>"
 *   - foldered        → "folder/<folder_id>"
 *   - otherwise       → "unfiled"
 * (Pure path-building; never throws. Components are ids/known kinds — already
 * ASCII — but slugged defensively so the key is guaranteed valid.)
 */
function buildPrefix(opts: {
  entityType?: string | null;
  entityId?: string | null;
  folderId?: string | null;
}): string {
  if (opts.entityType && opts.entityId) {
    return `${asciiSegment(opts.entityType) || 'entity'}/${asciiSegment(opts.entityId) || 'id'}`;
  }
  if (opts.folderId) return `folder/${asciiSegment(opts.folderId) || 'id'}`;
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

/**
 * Uploads a file under <prefix>/<uuid><.ext>. The key is fully ASCII and derived
 * from a random UUID + the original extension only — the (possibly Hebrew) file
 * name is NOT part of the key (Supabase rejects non-ASCII keys). The readable
 * name is stored separately in documents.file_name. Returns the storage path.
 */
export async function uploadDocumentFile(
  file: File,
  opts: { entityType?: string | null; entityId?: string | null; folderId?: string | null },
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  await ensureBucket(getStorage());
  const path = `${buildPrefix(opts)}/${randomUUID()}${extOf(file.name)}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(BUCKET, path, buffer, file.type || 'application/octet-stream');
  return { path, sizeBytes: buffer.byteLength, mimeType: file.type || '' };
}

/**
 * In-app, permission-checked URL for a stored object (relative by construction).
 * The proxy resolves the readable (Hebrew) documents.file_name itself, so callers
 * no longer pass a download name.
 */
export function fileUrlForPath(path: string): string {
  return buildProxyUrl(BUCKET, path);
}

/**
 * Downloads the raw object bytes for a stored path. Returns null if the object
 * is missing / cannot be read. Throws 'supabase_storage_not_configured' if the
 * service key is missing (so the caller can return a clear 503). Used by the
 * download route, which sets Content-Type / Content-Disposition itself — giving
 * full control over the (Hebrew) filename.
 */
export async function downloadDocumentFile(path: string): Promise<Blob | null> {
  return getObjectStream(BUCKET, path);
}

/** Removes the object from storage (best-effort; row state is authoritative). */
export async function removeDocumentFile(path: string): Promise<void> {
  await deleteObjects(BUCKET, [path]);
}

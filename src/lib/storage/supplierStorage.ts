import 'server-only';
import { buildObjectKey } from './objectKey';
import { buildProxyUrl, uploadObject, deleteObjects } from './server';

/**
 * Supplier-document storage. All Storage access goes through ./server.ts — this
 * module never touches the storage host or a signed URL.
 *
 * Bucket is PRIVATE: file_url stores the object PATH (not a URL). Files are served
 * only through /api/files/supplier-documents/<path>, which enforces suppliers:view
 * on every request.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error and the rest of the module is unaffected.
 */

const BUCKET = 'supplier-documents';

/** Uploads a file under <supplierId>/<uuid><.ext>. Returns the storage path. */
export async function uploadSupplierFile(
  supplierId: string,
  file: File,
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  // ASCII-safe key (uuid + extension only); the Hebrew name is kept as file_name
  // in the DB for display/download. See buildObjectKey for the why.
  const path = buildObjectKey(file.name, supplierId);
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(BUCKET, path, buffer, file.type || 'application/octet-stream');
  return { path, sizeBytes: buffer.byteLength, mimeType: file.type || '' };
}

/** In-app, permission-checked URL for a stored document (relative by construction). */
export function fileUrlForPath(path: string): string {
  return buildProxyUrl(BUCKET, path);
}

/** Removes the object from storage (best-effort; row deletion is authoritative). */
export async function removeSupplierFile(path: string): Promise<void> {
  await deleteObjects(BUCKET, [path]);
}

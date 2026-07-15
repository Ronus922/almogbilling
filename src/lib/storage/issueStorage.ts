import 'server-only';
import { buildObjectKey } from './objectKey';
import { buildProxyUrl, uploadObject, deleteObjects } from './server';

/**
 * Issue-image storage. All Storage access goes through ./server.ts — this module
 * never touches the storage host or a signed URL.
 *
 * Bucket is PRIVATE: issues.images stores the object PATH (not a URL). Images are
 * served only through /api/files/issue-attachments/<path>, which enforces
 * issues:view on every request.
 */

const BUCKET = 'issue-attachments';

/** Uploads a file under <issueId>/<uuid><.ext>. Returns the storage path. */
export async function uploadIssueImage(
  issueId: string,
  file: File,
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  // ASCII-safe key under the issue's prefix (the original name — Hebrew included —
  // is never placed in the key). The `${issueId}/` prefix keeps isPathUnderIssue
  // valid and the upload can never traverse outside this issue. See buildObjectKey.
  const path = buildObjectKey(file.name, issueId);
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(BUCKET, path, buffer, file.type || 'application/octet-stream');
  return { path, sizeBytes: buffer.byteLength, mimeType: file.type || '' };
}

/**
 * Uploads a video under <issueId>/<uuid><.ext>. Same bucket, prefix and guard as
 * images — `issue-attachments` is media-agnostic (migration 064 added the DB
 * column; storage was never image-only). Returns the storage path.
 */
export function uploadIssueVideo(
  issueId: string,
  file: File,
): Promise<{ path: string; sizeBytes: number; mimeType: string }> {
  return uploadIssueImage(issueId, file);
}

/** In-app, permission-checked URL for a stored image (relative by construction). */
export function imageUrlForPath(path: string): string {
  return buildProxyUrl(BUCKET, path);
}

/** Removes objects from storage (best-effort; the DB row is authoritative). */
export async function removeIssueImages(paths: string[]): Promise<void> {
  await deleteObjects(BUCKET, paths);
}

/**
 * Guard: a stored image path MUST live under the given issue's prefix
 * (`<issueId>/...`). Defends every image mutation against a forged path that
 * points at another issue's objects.
 */
export function isPathUnderIssue(path: string, issueId: string): boolean {
  return typeof path === 'string' && path.startsWith(`${issueId}/`) && !path.includes('..');
}

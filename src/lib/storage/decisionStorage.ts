import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, deleteObjects, PORTAL_DECISIONS_BUCKET as BUCKET } from './server';

/**
 * Storage for the PDF of a decision / protocol (public.portal_decisions). All
 * Storage access goes through ./server.ts — this module never touches the
 * storage host or a signed URL.
 *
 * The bucket is PRIVATE and the key is a bare `<uuid>.pdf` (ASCII, no prefix):
 * the readable Hebrew name lives only in portal_decisions.original_filename, so
 * nothing about the document is guessable from the key. A resident reaches the
 * bytes only through /api/portal/decisions/[id]/file (portal session + the row
 * is published); staff through /api/files/portal-decisions/<key>.
 */

export async function uploadDecisionFile(
  file: File,
  mimeType: string,
): Promise<{ objectKey: string; sizeBytes: number }> {
  await ensureBucket(BUCKET, { public: false });
  const objectKey = buildObjectKey(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(BUCKET, objectKey, buffer, mimeType);
  return { objectKey, sizeBytes: buffer.byteLength };
}

/** Removes the object (best-effort; the DB row is authoritative). */
export async function removeDecisionFile(objectKey: string): Promise<void> {
  await deleteObjects(BUCKET, [objectKey]);
}

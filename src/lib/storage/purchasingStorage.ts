import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, deleteObjects, getObjectStream, PURCHASING_FILES_BUCKET as BUCKET } from './server';

/**
 * Storage for purchasing: attachments of a request / purchase order, the files
 * a supplier uploads with a quote, and the letterhead's logo and signature. All
 * access goes through ./server.ts. The bucket is PRIVATE and the key is a bare
 * `<uuid>.<ext>` — the readable name lives only in purchasing_files.
 */

export async function uploadPurchasingObject(
  bytes: Buffer,
  originalName: string,
  mimeType: string,
): Promise<{ objectKey: string; sizeBytes: number }> {
  await ensureBucket(BUCKET, { public: false });
  const objectKey = buildObjectKey(originalName);
  await uploadObject(BUCKET, objectKey, bytes, mimeType);
  return { objectKey, sizeBytes: bytes.byteLength };
}

/** Best-effort removal (the DB row is authoritative). */
export async function removePurchasingObjects(objectKeys: string[]): Promise<void> {
  await deleteObjects(BUCKET, objectKeys);
}

/** The bytes of an object, or null when missing. */
export async function readPurchasingObject(objectKey: string): Promise<Buffer | null> {
  const blob = await getObjectStream(BUCKET, objectKey);
  return blob ? Buffer.from(await blob.arrayBuffer()) : null;
}

import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, deleteObjects, getObjectStream, FINANCE_RECEIPTS_BUCKET as BUCKET } from './server';

/**
 * Storage for the receipts/invoices of the finance module (fin_documents). All
 * Storage access goes through ./server.ts.
 *
 * The bucket is PRIVATE: the browser reaches a file only through
 * /api/files/finance-receipts/<key> (session + finance:view). The object key is
 * `<uuid>.<ext>` (ASCII); the readable (Hebrew) name lives only in
 * fin_documents.original_name. The Drive backup downloads the bytes back
 * through downloadFinanceReceipt — never through a URL.
 */

export { BUCKET as FINANCE_RECEIPTS_BUCKET };

export async function uploadFinanceReceipt(
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
export async function removeFinanceReceipt(objectKey: string): Promise<void> {
  await deleteObjects(BUCKET, [objectKey]);
}

/** The object bytes for the Drive backup, or null when missing. */
export async function downloadFinanceReceipt(objectKey: string): Promise<Buffer | null> {
  const blob = await getObjectStream(BUCKET, objectKey);
  if (!blob) return null;
  return Buffer.from(await blob.arrayBuffer());
}

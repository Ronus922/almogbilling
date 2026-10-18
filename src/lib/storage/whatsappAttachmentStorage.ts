import 'server-only';
import { buildObjectKey } from './objectKey';
import {
  ensureBucket,
  uploadObject,
  getObjectStream,
  deleteObjects,
  WHATSAPP_ATTACHMENTS_BUCKET as BUCKET,
} from './server';

/**
 * Storage for WhatsApp attachments — BOTH the broadcast ones
 * (wa_campaign_attachments) and those of a single outbound message
 * (wa_message_attachments). All Storage access goes through ./server.ts.
 *
 * The bucket is PRIVATE: the browser reaches a file only through
 * /api/files/whatsapp-attachments/<key> (session + whatsapp_chat:view or
 * whatsapp:view), and the
 * worker never hands anyone a storage URL — it uploads the bytes to Green API's
 * own cloud (uploadFile) and reuses THAT link for every recipient. The object
 * key is `<uuid>.<ext>` (ASCII); the readable (Hebrew) name lives only in
 * wa_campaign_attachments.original_name.
 */

export { BUCKET as WHATSAPP_ATTACHMENTS_BUCKET };

/** Uploads a staged attachment. `mimeType` is the canonical MIME for
 *  the file's extension (not the browser's guess) so Green API and the proxy
 *  serve it with a type WhatsApp understands. Returns the object key. */
export async function uploadWhatsAppAttachment(
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
export async function removeWhatsAppAttachment(objectKey: string): Promise<void> {
  await deleteObjects(BUCKET, [objectKey]);
}

/**
 * Duplicates an already-staged attachment's BYTES under a fresh object key —
 * for the multi-recipient single-send (18/10/2026): every recipient needs its
 * own wa_message_attachments row, and `object_key` is UNIQUE (the file-serving
 * proxy, /api/files/[bucket]/[...path], looks a row up BY its object_key, so
 * two rows may never share one — that lookup would always resolve to whichever
 * row ties, silently misattributing the other). The Green API link itself is
 * NOT re-fetched here; the caller already has it and writes it straight onto
 * the new DB row, so the physical upload to Green still happens exactly once
 * per file, no matter how many recipients it goes to. */
export async function cloneWhatsAppAttachment(
  sourceObjectKey: string,
  originalName: string,
  mimeType: string,
): Promise<{ objectKey: string; sizeBytes: number }> {
  const blob = await getObjectStream(BUCKET, sourceObjectKey);
  if (!blob) throw new Error('הקובץ לא נמצא באחסון');
  const buffer = Buffer.from(await blob.arrayBuffer());
  const objectKey = buildObjectKey(originalName);
  await uploadObject(BUCKET, objectKey, buffer, mimeType);
  return { objectKey, sizeBytes: buffer.byteLength };
}

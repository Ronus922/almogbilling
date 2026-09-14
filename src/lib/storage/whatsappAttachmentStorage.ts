import 'server-only';
import { buildObjectKey } from './objectKey';
import {
  ensureBucket,
  uploadObject,
  deleteObjects,
  buildProxyUrl,
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

/** In-app, permission-checked URL for a stored attachment (relative). */
export function whatsAppAttachmentUrl(objectKey: string): string {
  return buildProxyUrl(BUCKET, objectKey);
}

import 'server-only';
import { buildObjectKey } from './objectKey';
import {
  getStorage,
  uploadObject,
  buildPublicWaMediaUrl,
  WHATSAPP_MEDIA_BUCKET as BUCKET,
} from './server';

/**
 * WhatsApp media storage. All Storage access goes through ./server.ts.
 *
 * The bucket is public, but the URL we hand out is NOT the storage URL: outbound
 * attachments are addressed through /api/public/wa-media on our own origin, so
 * the storage host never reaches Green API or the WhatsApp recipient. That route
 * is unauthenticated by necessity — Green API's servers hold no session of ours.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error and the rest of the module is unaffected.
 */

/**
 * Uploads a WhatsApp media file to the public bucket.
 * Path: <uuid><.ext> (ASCII-safe; the original name is sent to Green API as the
 * fileName param, independent of the storage key)
 * Returns the app-origin URL (reachable by Green API servers), the MIME type,
 * and the file size in bytes.
 *
 * Best-effort bucket creation: calls createBucket with public:true and ignores
 * "already exists" errors so the route works on first deploy without a manual
 * bucket setup step.
 */
export async function uploadWhatsAppMedia(
  file: File,
): Promise<{ url: string; mimeType: string; sizeBytes: number }> {
  // Ensure the bucket exists and is public — safe to call every time; the
  // storage server returns an error code we recognise and swallow.
  try {
    await getStorage().createBucket(BUCKET, { public: true });
  } catch {
    // Bucket already exists or non-fatal — continue.
  }

  const path = buildObjectKey(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  await uploadObject(BUCKET, path, buffer, mimeType);

  return { url: buildPublicWaMediaUrl(path), mimeType, sizeBytes: buffer.byteLength };
}

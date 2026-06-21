import 'server-only';
import { StorageClient } from '@supabase/storage-js';
import { buildObjectKey } from './objectKey';

/**
 * WhatsApp media storage on the self-hosted Supabase Storage.
 * Uses StorageClient directly (not the full supabase-js client) so it runs on
 * Node 20 without the realtime WebSocket dependency.
 *
 * Bucket is PUBLIC: Green API's servers must be able to GET the file URL without
 * authentication. uploadWhatsAppMedia returns the full public URL directly.
 *
 * NOTE: requires a valid SUPABASE_SERVICE_ROLE_KEY (a complete JWT) for the
 * self-hosted instance. If the key is missing/malformed, uploads fail with a
 * clear error and the rest of the module is unaffected.
 */

const BUCKET = 'whatsapp-media';

function getStorage(): StorageClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase_storage_not_configured');
  return new StorageClient(`${url.replace(/\/$/, '')}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

/**
 * Uploads a WhatsApp media file to the public bucket.
 * Path: <uuid><.ext> (ASCII-safe; the original name is sent to Green API as the
 * fileName param, independent of the storage key)
 * Returns the public URL (reachable by Green API servers), the MIME type, and
 * the file size in bytes.
 *
 * Best-effort bucket creation: calls createBucket with public:true and ignores
 * "already exists" errors so the route works on first deploy without a manual
 * bucket setup step.
 */
export async function uploadWhatsAppMedia(
  file: File,
): Promise<{ url: string; mimeType: string; sizeBytes: number }> {
  const storage = getStorage();

  // Ensure the bucket exists and is public — safe to call every time; the
  // storage server returns an error code we recognise and swallow.
  try {
    await storage.createBucket(BUCKET, { public: true });
  } catch {
    // Bucket already exists or non-fatal — continue.
  }

  const path = buildObjectKey(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || 'application/octet-stream';

  const { error } = await storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: false,
  });

  if (error) throw new Error(`storage_upload_failed: ${error.message}`);

  const { data } = storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, mimeType, sizeBytes: buffer.byteLength };
}

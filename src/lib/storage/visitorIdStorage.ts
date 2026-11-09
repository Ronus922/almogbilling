import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, removeObjectsStrict, VISITOR_IDS_BUCKET as BUCKET } from './server';
import type { CompressedImage } from '@/lib/visitors/image';

/**
 * Storage for the photos of scanned visitor documents. All access goes through
 * ./server.ts. The bucket is PRIVATE and the key is a bare `<uuid>.webp` (`.jpg` for the
 * rows saved before 09/11/2026, and for the net-under-WebP case) — the name of the photo the
 * guard took lives only in visitor_scans. The photo is served by /api/files/visitor-ids/<key>
 * (session + role + audit), never by a URL.
 */

/** Stores the (already compressed) photo and returns its object key. */
export async function uploadVisitorPhoto(img: Pick<CompressedImage, 'bytes' | 'contentType' | 'ext'>): Promise<string> {
  await ensureBucket(BUCKET, { public: false });
  const objectKey = buildObjectKey(`scan.${img.ext}`);
  await uploadObject(BUCKET, objectKey, img.bytes, img.contentType);
  return objectKey;
}

/** Removes the photo; false (and a log line with the key) when Storage did not. The bucket is
 *  outside the Storage GC on purpose, so nothing else would ever find a photo left behind. */
export async function removeVisitorPhoto(objectKey: string): Promise<boolean> {
  return removeObjectsStrict(BUCKET, [objectKey]);
}

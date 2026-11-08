import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, removeObjectsStrict, VISITOR_IDS_BUCKET as BUCKET } from './server';

/**
 * Storage for the photos of scanned visitor documents. All access goes through
 * ./server.ts. The bucket is PRIVATE and the key is a bare `<uuid>.jpg` — the
 * name of the photo the guard took (as `.jpg`) lives only in visitor_scans. The photo is
 * served by /api/files/visitor-ids/<key> (session + role + audit), never by a URL.
 */

/** Stores the (already normalised) JPEG and returns its object key. */
export async function uploadVisitorPhoto(jpeg: Buffer): Promise<string> {
  await ensureBucket(BUCKET, { public: false });
  const objectKey = buildObjectKey('scan.jpg');
  await uploadObject(BUCKET, objectKey, jpeg, 'image/jpeg');
  return objectKey;
}

/** Removes the photo; false (and a log line with the key) when Storage did not. The bucket is
 *  outside the Storage GC on purpose, so nothing else would ever find a photo left behind. */
export async function removeVisitorPhoto(objectKey: string): Promise<boolean> {
  return removeObjectsStrict(BUCKET, [objectKey]);
}

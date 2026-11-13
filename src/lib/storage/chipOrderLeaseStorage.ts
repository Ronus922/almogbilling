import 'server-only';
import { buildObjectKey } from './objectKey';
import {
  ensureBucket, uploadObject, deleteObjects, removeObjectsStrict, CHIP_ORDER_LEASES_BUCKET as BUCKET,
} from './server';

/**
 * Storage for chip-order leases (/chip-order). The bucket is PRIVATE and the
 * key is a bare `<uuid>.<ext>` — the readable name lives only in
 * chip_order_items.lease_file_name. Staff open a lease through
 * /api/files/chip-order-leases/<key>; there is no signed or public URL.
 */
export async function uploadChipOrderLease(
  bytes: Buffer,
  originalName: string,
  mimeType: string,
): Promise<{ objectKey: string; sizeBytes: number }> {
  await ensureBucket(BUCKET, { public: false });
  const objectKey = buildObjectKey(originalName);
  await uploadObject(BUCKET, objectKey, bytes, mimeType);
  return { objectKey, sizeBytes: bytes.byteLength };
}

/** Best-effort removal of objects an order failed to keep (the DB row is authoritative). */
export async function removeChipOrderLeases(objectKeys: string[]): Promise<void> {
  if (objectKeys.length === 0) return;
  await deleteObjects(BUCKET, objectKeys);
}

/** Removal that reports the truth — for deleting an order (unpaid purge, test
 *  orders): false = Storage refused, so the caller keeps the row and retries. */
export async function removeChipOrderLeasesStrict(objectKeys: string[]): Promise<boolean> {
  return removeObjectsStrict(BUCKET, objectKeys);
}

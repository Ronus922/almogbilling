import 'server-only';
import { buildObjectKey } from './objectKey';
import { ensureBucket, uploadObject, deleteObjects, REMINDER_ATTACHMENTS_BUCKET as BUCKET } from './server';

/**
 * Storage for the files attached to a reminder (user_reminder_attachments). All
 * Storage access goes through ./server.ts.
 *
 * The bucket is PRIVATE: the browser reaches a file only through
 * /api/files/reminder-attachments/<key> (session + user_reminders:view). The
 * object key is `<uuid>.<ext>` (ASCII); the readable (Hebrew) name lives only in
 * user_reminder_attachments.original_name.
 */

export async function uploadReminderAttachment(
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
export async function removeReminderAttachment(objectKey: string): Promise<void> {
  await deleteObjects(BUCKET, [objectKey]);
}

import 'server-only';
import { query, queryOne } from '@/lib/db';
import { buildProxyUrl } from '@/lib/storage/server';
import type { UserReminderAttachmentView } from '@/lib/types/userReminders';

// Files attached to a reminder (user_reminder_attachments). Same lifecycle as
// fin_documents: a row is STAGED at upload time (reminder_id NULL, owned by
// uploaded_by) and linked to the reminder on save.

export interface UserReminderAttachment {
  id: string;
  reminder_id: string | null;
  uploaded_by: string | null;
  bucket: string;
  object_key: string;
  original_name: string;
  mime: string;
  size: number;
  object_deleted_at: string | null;
  created_at: string;
}

// Timestamps come back from pg as Date objects; toAttachmentView normalizes
// created_at to an ISO string (what the panel parses).
const COLS = `
  id, reminder_id, uploaded_by, bucket, object_key, original_name, mime, size::int as size,
  object_deleted_at, created_at`;

export function toAttachmentView(a: UserReminderAttachment): UserReminderAttachmentView {
  return {
    id: a.id,
    original_name: a.original_name,
    mime: a.mime,
    size: a.size,
    url: buildProxyUrl('reminder-attachments', a.object_key),
    created_at: new Date(a.created_at).toISOString(),
  };
}

export async function insertStagedAttachment(input: {
  uploadedBy: string; objectKey: string; originalName: string; mime: string; size: number;
}): Promise<UserReminderAttachment> {
  const r = await query<UserReminderAttachment>(
    `insert into public.user_reminder_attachments (uploaded_by, object_key, original_name, mime, size)
     values ($1, $2, $3, $4, $5)
     returning ${COLS}`,
    [input.uploadedBy, input.objectKey, input.originalName, input.mime, input.size],
  );
  return r.rows[0];
}

/** Remove a STAGED file the actor uploaded; returns the row (so the caller can
 *  delete the object) or null when it is not theirs / already linked. */
export async function deleteStagedAttachment(id: string, uploadedBy: string): Promise<UserReminderAttachment | null> {
  const r = await query<UserReminderAttachment>(
    `delete from public.user_reminder_attachments
      where id = $1 and reminder_id is null and uploaded_by = $2
      returning ${COLS}`,
    [id, uploadedBy],
  );
  return r.rows[0] ?? null;
}

/** Remove a LINKED file of a reminder (the edit panel's delete). Any reminder
 *  editor may do it. */
export async function deleteReminderAttachment(id: string, reminderId: string): Promise<UserReminderAttachment | null> {
  const r = await query<UserReminderAttachment>(
    `delete from public.user_reminder_attachments
      where id = $1 and reminder_id = $2
      returning ${COLS}`,
    [id, reminderId],
  );
  return r.rows[0] ?? null;
}

/** Link staged files to the reminder. Returns how many rows were linked, so the
 *  caller can tell that one was not the actor's (or its bytes are gone). */
export async function linkAttachments(reminderId: string, ids: string[], uploadedBy: string): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await query(
    `update public.user_reminder_attachments
        set reminder_id = $1
      where id = any($2::uuid[]) and reminder_id is null and uploaded_by = $3
        and object_deleted_at is null`,
    [reminderId, ids, uploadedBy],
  );
  return r.rowCount ?? 0;
}

/** The live files of a reminder, oldest first (= upload order). */
export async function listReminderAttachments(reminderId: string): Promise<UserReminderAttachment[]> {
  const r = await query<UserReminderAttachment>(
    `select ${COLS} from public.user_reminder_attachments
      where reminder_id = $1 and object_deleted_at is null
      order by created_at, id`,
    [reminderId],
  );
  return r.rows;
}

export async function getAttachment(id: string): Promise<UserReminderAttachment | null> {
  return queryOne<UserReminderAttachment>(
    `select ${COLS} from public.user_reminder_attachments where id = $1`,
    [id],
  );
}

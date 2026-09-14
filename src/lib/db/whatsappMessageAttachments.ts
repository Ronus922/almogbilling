import type { Pool, PoolClient } from 'pg';
import { getDbPool } from '@/lib/db';

// Attachments of ONE outbound WhatsApp message (wa_message_attachments) — the
// single-recipient "שליחת הודעת WhatsApp" sheet. Same shape and lifecycle as the
// broadcast table: a row is staged at upload time (message_id NULL, owned by
// uploaded_by) and linked to the chat_messages row when the message is sent.
// The bytes live in the PRIVATE whatsapp-attachments bucket; green_api_url is
// the link Green API `uploadFile` gives back (15 days), which is what
// sendFileByUrl receives — no public URL is ever produced.

type Q = Pool | PoolClient;

export interface MessageAttachment {
  id: string;
  message_id: string | null;
  uploaded_by: string | null;
  bucket: string;
  object_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sort_order: number;
  green_api_url: string | null;
  green_api_url_expires_at: string | null;
  green_api_error: string | null;
  created_at: string;
}

/** What the history exposes per attachment (+ the authenticated proxy `url`). */
export interface MessageAttachmentView {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  url: string;
}

const COLS = `
  id, message_id, uploaded_by, bucket, object_key, original_name, mime_type,
  size_bytes::int as size_bytes, sort_order, green_api_url,
  green_api_url_expires_at, green_api_error, created_at`;

export async function insertStagedMessageAttachment(input: {
  uploadedBy: string; bucket: string; objectKey: string;
  originalName: string; mimeType: string; sizeBytes: number;
}): Promise<MessageAttachment> {
  const r = await getDbPool().query<MessageAttachment>(
    `insert into public.wa_message_attachments
       (uploaded_by, bucket, object_key, original_name, mime_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     returning ${COLS}`,
    [input.uploadedBy, input.bucket, input.objectKey, input.originalName, input.mimeType, input.sizeBytes],
  );
  return r.rows[0];
}

/** Staged (not yet sent) attachments owned by `uploadedBy`, in the order of
 *  `ids` — which is the order the user arranged them in, i.e. the send order. */
export async function listStagedMessageAttachments(ids: string[], uploadedBy: string): Promise<MessageAttachment[]> {
  if (ids.length === 0) return [];
  const r = await getDbPool().query<MessageAttachment>(
    `select ${COLS} from public.wa_message_attachments
      where id = any($1::uuid[]) and message_id is null and uploaded_by = $2`,
    [ids, uploadedBy],
  );
  const byId = new Map(r.rows.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is MessageAttachment => a !== undefined);
}

/** Remove a staged attachment the actor uploaded; returns the row (so the
 *  caller can delete the object) or null when it is not theirs / already sent. */
export async function deleteStagedMessageAttachment(id: string, uploadedBy: string): Promise<MessageAttachment | null> {
  const r = await getDbPool().query<MessageAttachment>(
    `delete from public.wa_message_attachments
      where id = $1 and message_id is null and uploaded_by = $2
      returning ${COLS}`,
    [id, uploadedBy],
  );
  return r.rows[0] ?? null;
}

/** Link staged attachments to the message row, in the given order. Returns how
 *  many rows were linked, so the caller can tell that one was not the actor's. */
export async function linkMessageAttachments(
  q: Q, messageId: string, ids: string[], uploadedBy: string,
): Promise<number> {
  let linked = 0;
  for (let i = 0; i < ids.length; i++) {
    const r = await q.query(
      `update public.wa_message_attachments
          set message_id = $1, sort_order = $2
        where id = $3 and message_id is null and uploaded_by = $4`,
      [messageId, i, ids[i], uploadedBy],
    );
    linked += r.rowCount ?? 0;
  }
  return linked;
}

/** Persist the Green API link (valid `lifetimeDays`) for a staged/sent file. */
export async function recordMessageAttachmentUrl(id: string, urlFile: string, lifetimeDays: number): Promise<void> {
  await getDbPool().query(
    `update public.wa_message_attachments
        set green_api_url = $2,
            green_api_url_expires_at = now() + ($3 || ' days')::interval,
            green_api_error = null
      where id = $1`,
    [id, urlFile, String(lifetimeDays)],
  );
}

export async function recordMessageAttachmentError(id: string, message: string): Promise<void> {
  await getDbPool().query(
    `update public.wa_message_attachments set green_api_error = $2 where id = $1`,
    [id, message.slice(0, 500)],
  );
}

export async function listMessageAttachments(messageId: string): Promise<MessageAttachment[]> {
  const r = await getDbPool().query<MessageAttachment>(
    `select ${COLS} from public.wa_message_attachments
      where message_id = $1 order by sort_order, created_at`,
    [messageId],
  );
  return r.rows;
}

/** Attachments of many messages at once (history rendering), grouped by message. */
export async function listAttachmentsForMessages(messageIds: string[]): Promise<Map<string, MessageAttachment[]>> {
  const out = new Map<string, MessageAttachment[]>();
  if (messageIds.length === 0) return out;
  const r = await getDbPool().query<MessageAttachment>(
    `select ${COLS} from public.wa_message_attachments
      where message_id = any($1::uuid[]) order by sort_order, created_at`,
    [messageIds],
  );
  for (const row of r.rows) {
    if (!row.message_id) continue;
    const list = out.get(row.message_id);
    if (list) list.push(row);
    else out.set(row.message_id, [row]);
  }
  return out;
}

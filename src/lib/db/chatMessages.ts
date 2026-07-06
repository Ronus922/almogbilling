import 'server-only';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, withTransaction } from '@/lib/db';
import { normalizeChatLink } from '@/lib/whatsapp-link';
import type {
  ChatMessage,
  ChatDirection,
  ChatStatus,
  ChatMessageType,
  ChatLinkStatus,
  UnlinkedMessage,
} from '@/types/whatsapp';

// Minimal executor shape satisfied by both the pool (`query`) and a PoolClient
// inside a transaction — lets one insert helper serve both the standalone
// (failure) path and the transactional (success) path.
interface Executor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface InsertChatMessageArgs {
  debtorId: string | null;
  /** Linked supplier id (XOR with debtorId) — set when the inbound/outbound
   *  number matched a supplier rather than a debtor. Defaults to null. */
  supplierId?: string | null;
  contactPhone: string;
  chatId: string | null;
  externalMessageId: string | null;
  direction: ChatDirection;
  messageType?: ChatMessageType;
  /** Defaults to 'linked'. Inbound messages with no matching debtor pass 'unlinked'. */
  linkStatus?: ChatLinkStatus;
  content: string | null;
  /** Media URL for image/document messages (mirrors content for inbound files). */
  mediaUrl?: string | null;
  /** Original (Hebrew) file name of an outbound attachment — for the history row
   *  label. The storage key is a UUID, so the readable name lives only here. */
  attachmentName?: string | null;
  /** Attachment MIME type (drives the history icon). */
  attachmentMime?: string | null;
  /** Attachment size in bytes. */
  attachmentSize?: number | null;
  status: ChatStatus;
  errorDetail?: string | null;
  sentBy: string | null;
  /** Campaign id when this row is part of a broadcast. */
  broadcastId?: string | null;
  /** Sending/receiving Green API instance (uuid FK → whatsapp_instances). */
  instanceId?: string | null;
  /** Inbound gateway timestamp (unix seconds). Omitted → DB default now(). */
  createdAtUnix?: number | null;
}

/** Insert a chat_messages row. Pass a PoolClient to run inside a transaction,
 *  or omit (defaults to the pool) for a standalone insert. Returns the new id,
 *  or null when an ON CONFLICT (external_message_id) DO NOTHING suppressed the
 *  insert (a duplicate inbound message). */
export async function insertChatMessage(
  args: InsertChatMessageArgs,
  exec: Executor = { query },
): Promise<string | null> {
  const r = await exec.query<{ id: string }>(
    `insert into public.chat_messages
       (debtor_id, supplier_id, contact_phone, chat_id, external_message_id,
        direction, message_type, link_status, content, status, error_detail, sent_by,
        media_url, broadcast_id, instance_id, created_at,
        attachment_name, attachment_mime, attachment_size)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             coalesce(to_timestamp($16), now()), $17, $18, $19)
     on conflict (external_message_id) do nothing
     returning id`,
    [
      args.debtorId,
      args.supplierId ?? null,
      args.contactPhone,
      args.chatId,
      args.externalMessageId,
      args.direction,
      args.messageType ?? 'text',
      args.linkStatus ?? 'linked',
      args.content,
      args.status,
      args.errorDetail ?? null,
      args.sentBy,
      args.mediaUrl ?? null,
      args.broadcastId ?? null,
      args.instanceId ?? null,
      args.createdAtUnix ?? null,
      args.attachmentName ?? null,
      args.attachmentMime ?? null,
      args.attachmentSize ?? null,
    ],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Update the delivery status of an outbound message by its Green API idMessage.
 * Monotonic: never downgrades (a late 'delivered' won't overwrite a 'read'); a
 * 'failed' always applies.
 *
 * Returns { matched, advanced } in one round-trip:
 *   • matched  — an outbound row with this idMessage exists (so the caller can
 *     warn ONLY on a genuinely unknown message, not on the duplicate / out-of-order
 *     status webhooks Green API routinely re-delivers).
 *   • advanced — the status actually moved forward (a row was updated).
 */
export async function updateMessageStatusByExternalId(
  externalMessageId: string,
  status: ChatStatus,
): Promise<{ matched: boolean; advanced: boolean }> {
  const r = await query<{ matched: boolean; advanced: boolean }>(
    `with existing as (
        select 1 from public.chat_messages
         where external_message_id = $1 and direction = 'sent'
         limit 1
     ),
     upd as (
        update public.chat_messages
           set status = $2
         where external_message_id = $1
           and direction = 'sent'
           and ($2 = 'failed'
                or (case status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end)
                   < (case $2     when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end))
        returning 1
     )
     select exists(select 1 from existing) as matched,
            exists(select 1 from upd)      as advanced`,
    [externalMessageId, status],
  );
  return { matched: r.rows[0]?.matched ?? false, advanced: r.rows[0]?.advanced ?? false };
}

export interface ResendableMessage {
  id: string;
  chat_id: string | null;
  contact_phone: string;
  content: string | null;
  message_type: ChatMessageType;
  media_url: string | null;
  instance_id: string | null;
  debtor_id: string | null;
}

/** Fetch a failed OUTBOUND message for a resend attempt (null if not eligible). */
export async function getResendableMessage(id: string): Promise<ResendableMessage | null> {
  const r = await query<ResendableMessage>(
    `select id, chat_id, contact_phone, content, message_type, media_url, instance_id, debtor_id
       from public.chat_messages
      where id = $1 and direction = 'sent' and status = 'failed'
      limit 1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Resend succeeded — flip the existing row to 'sent' with its new Green API id
 *  (no new row, so the bubble updates in place). */
export async function markMessageResent(id: string, externalMessageId: string): Promise<void> {
  await query(
    `update public.chat_messages
        set status = 'sent', external_message_id = $2, error_detail = null, created_at = now()
      where id = $1`,
    [id, externalMessageId],
  );
}

/** Resend failed again — refresh the error detail, keep the row 'failed'. */
export async function markMessageResendFailed(id: string, detail: string): Promise<void> {
  await query(
    `update public.chat_messages set error_detail = $2 where id = $1`,
    [id, detail],
  );
}

/** Convenience overload for the transactional success path. */
export function insertChatMessageTx(
  client: PoolClient,
  args: InsertChatMessageArgs,
): Promise<string | null> {
  return insertChatMessage(args, client);
}

/** Inbound messages with no matched debtor — the "הודעות לא משויכות" inbox. */
export async function listUnlinkedMessages(limit = 200): Promise<UnlinkedMessage[]> {
  const r = await query<UnlinkedMessage>(
    `select id, contact_phone, chat_id, message_type, content, created_at
       from public.chat_messages
      where link_status = 'unlinked'
      order by created_at desc
      limit $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return r.rows;
}

/** Count of currently-unlinked inbound messages (for the nav badge / empty check). */
export async function countUnlinkedMessages(): Promise<number> {
  const r = await query<{ c: string }>(
    `select count(*)::text as c from public.chat_messages where link_status = 'unlinked'`,
  );
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * Set (or clear) a whole conversation's link target, enforcing the XOR rule: a
 * conversation is attached to a debtor OR a supplier OR neither — linking to one
 * clears the other. The target message id identifies the conversation; EVERY row
 * sharing its chat_id is updated (so inbound + outbound stay consistent), keyed
 * on the stable chat_id (the "972…@c.us" grouping key) with a contact_phone
 * fallback for the rare row with no chat_id.
 *
 * Unlike the old debtor-only helper, this acts regardless of current
 * link_status, so it powers the initial link, re-linking (debtor↔supplier) and
 * unlinking alike. `link_status` is derived from the normalized target. Returns
 * the number of rows updated, or null if the message id is unknown.
 */
export async function setConversationLink(
  messageId: string,
  target: { debtorId?: string | null; supplierId?: string | null },
): Promise<number | null> {
  const { debtorId, supplierId, linkStatus } = normalizeChatLink(target);
  return withTransaction(async (client) => {
    const row = await client.query<{ chat_id: string | null; contact_phone: string }>(
      `select chat_id, contact_phone from public.chat_messages
        where id = $1
        for update`,
      [messageId],
    );
    if (row.rowCount === 0) return null;
    const { chat_id, contact_phone } = row.rows[0];
    const upd = chat_id
      ? await client.query(
          `update public.chat_messages
              set debtor_id = $1, supplier_id = $2, link_status = $3
            where chat_id = $4`,
          [debtorId, supplierId, linkStatus, chat_id],
        )
      : await client.query(
          `update public.chat_messages
              set debtor_id = $1, supplier_id = $2, link_status = $3
            where contact_phone = $4`,
          [debtorId, supplierId, linkStatus, contact_phone],
        );
    return upd.rowCount ?? 0;
  });
}

/** Contact phone (DB-canonical local form) of the conversation a message belongs
 *  to — used to seed a "create supplier from this number" flow. Null if unknown. */
export async function getMessageContactPhone(messageId: string): Promise<string | null> {
  const r = await query<{ contact_phone: string }>(
    `select contact_phone from public.chat_messages where id = $1 limit 1`,
    [messageId],
  );
  return r.rows[0]?.contact_phone ?? null;
}

/** Messages for one debtor, oldest → newest (chat order). Joins the sender name. */
export async function listChatMessagesByDebtor(debtorId: string): Promise<ChatMessage[]> {
  const r = await query<ChatMessage>(
    `select
        m.id, m.debtor_id, m.supplier_id, m.contact_phone, m.chat_id, m.external_message_id,
        m.link_status, m.direction, m.message_type, m.content, m.media_url, m.status,
        m.error_detail, m.sent_by, m.attachment_name, m.attachment_mime, m.attachment_size,
        u.full_name as sent_by_name,
        s.display_name as supplier_display_name,
        m.broadcast_id, m.read_at, m.created_at
       from public.chat_messages m
       left join public.users u on u.id = m.sent_by
       left join public.suppliers s on s.id = m.supplier_id
      where m.debtor_id = $1
      order by m.created_at asc`,
    [debtorId],
  );
  return r.rows;
}

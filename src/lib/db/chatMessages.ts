import 'server-only';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query, withTransaction } from '@/lib/db';
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
  contactPhone: string;
  chatId: string | null;
  externalMessageId: string | null;
  direction: ChatDirection;
  messageType?: ChatMessageType;
  /** Defaults to 'linked'. Inbound messages with no matching debtor pass 'unlinked'. */
  linkStatus?: ChatLinkStatus;
  content: string | null;
  status: ChatStatus;
  errorDetail?: string | null;
  sentBy: string | null;
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
       (debtor_id, contact_phone, chat_id, external_message_id,
        direction, message_type, link_status, content, status, error_detail, sent_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             coalesce(to_timestamp($12), now()))
     on conflict (external_message_id) do nothing
     returning id`,
    [
      args.debtorId,
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
      args.createdAtUnix ?? null,
    ],
  );
  return r.rows[0]?.id ?? null;
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
 * Link an unlinked message to a debtor. To attach the whole conversation in one
 * action, EVERY unlinked message from the same contact_phone is linked too.
 * Returns the number of rows linked, or null if the id is unknown / already linked.
 */
export async function linkMessagesToDebtor(
  messageId: string,
  debtorId: string,
): Promise<number | null> {
  return withTransaction(async (client) => {
    const target = await client.query<{ contact_phone: string }>(
      `select contact_phone from public.chat_messages
        where id = $1 and link_status = 'unlinked'
        for update`,
      [messageId],
    );
    if (target.rowCount === 0) return null;
    const phone = target.rows[0].contact_phone;
    const upd = await client.query(
      `update public.chat_messages
          set debtor_id = $1, link_status = 'linked'
        where link_status = 'unlinked' and contact_phone = $2`,
      [debtorId, phone],
    );
    return upd.rowCount ?? 0;
  });
}

/** Messages for one debtor, oldest → newest (chat order). Joins the sender name. */
export async function listChatMessagesByDebtor(debtorId: string): Promise<ChatMessage[]> {
  const r = await query<ChatMessage>(
    `select
        m.id, m.debtor_id, m.contact_phone, m.chat_id, m.external_message_id,
        m.link_status, m.direction, m.message_type, m.content, m.status,
        m.error_detail, m.sent_by,
        u.full_name as sent_by_name,
        m.created_at
       from public.chat_messages m
       left join public.users u on u.id = m.sent_by
      where m.debtor_id = $1
      order by m.created_at asc`,
    [debtorId],
  );
  return r.rows;
}

import 'server-only';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query } from '@/lib/db';
import type {
  ChatMessage,
  ChatDirection,
  ChatStatus,
  ChatMessageType,
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
  content: string | null;
  status: ChatStatus;
  errorDetail?: string | null;
  sentBy: string | null;
}

/** Insert a chat_messages row. Pass a PoolClient to run inside a transaction,
 *  or omit (defaults to the pool) for a standalone insert. Returns the new id. */
export async function insertChatMessage(
  args: InsertChatMessageArgs,
  exec: Executor = { query },
): Promise<string> {
  const r = await exec.query<{ id: string }>(
    `insert into public.chat_messages
       (debtor_id, contact_phone, chat_id, external_message_id,
        direction, message_type, content, status, error_detail, sent_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      args.debtorId,
      args.contactPhone,
      args.chatId,
      args.externalMessageId,
      args.direction,
      args.messageType ?? 'text',
      args.content,
      args.status,
      args.errorDetail ?? null,
      args.sentBy,
    ],
  );
  return r.rows[0].id;
}

/** Convenience overload for the transactional success path. */
export function insertChatMessageTx(
  client: PoolClient,
  args: InsertChatMessageArgs,
): Promise<string> {
  return insertChatMessage(args, client);
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

import 'server-only';
import { query } from '@/lib/db';
import { chatIdToLocalPhone } from '@/lib/whatsapp';
import type { Conversation, ThreadMessage } from '@/types/whatsapp';

// Conversation/thread queries for the /messages inbox. A conversation groups
// chat_messages by chat_id (the stable "<digits>@c.us" / "<id>@g.us" key shared
// by inbound + outbound rows). There is no contacts table in this project, so a
// conversation links to a debtor (matched at insert time by phone) rather than a
// generic contact; the display name resolves from that debtor.

interface ConvRow {
  chat_id: string;
  contact_phone: string | null;
  debtor_id: string | null;
  last_content: string | null;
  last_type: Conversation['last_type'];
  last_direction: Conversation['last_direction'];
  last_at: string;
  unread: string;
  owner_name: string | null;
  tenant_name: string | null;
  apartment_number: string | null;
}

/**
 * List conversations newest-first. Groups by chat_id; the most-recent message
 * supplies the preview, and a LATERAL join resolves the linked debtor's name.
 * `search` (optional) matches the phone, debtor name or apartment number.
 */
export async function listConversations(search = '', limit = 200): Promise<Conversation[]> {
  const term = search.trim();
  const like = `%${term}%`;
  const r = await query<ConvRow>(
    `with convo as (
        select
          m.chat_id,
          max(m.created_at)                                                   as last_at,
          count(*) filter (where m.direction = 'received' and m.read_at is null) as unread,
          (array_agg(m.contact_phone order by m.created_at desc))[1]          as contact_phone,
          (array_agg(m.debtor_id order by m.created_at desc)
             filter (where m.debtor_id is not null))[1]                       as debtor_id,
          (array_agg(coalesce(m.content, '') order by m.created_at desc))[1]  as last_content,
          (array_agg(m.message_type order by m.created_at desc))[1]          as last_type,
          (array_agg(m.direction order by m.created_at desc))[1]             as last_direction
        from public.chat_messages m
        where m.chat_id is not null
        group by m.chat_id
     )
     select c.chat_id, c.contact_phone, c.debtor_id, c.last_content, c.last_type,
            c.last_direction, c.last_at, c.unread::text as unread,
            d.owner_name, d.tenant_name, d.apartment_number
       from convo c
       left join public.debtors d on d.id = c.debtor_id
      where ($1 = ''
             or c.contact_phone ilike $2
             or d.owner_name     ilike $2
             or d.tenant_name    ilike $2
             or d.apartment_number ilike $2)
      order by c.last_at desc
      limit $3`,
    [term, like, Math.max(1, Math.min(500, limit))],
  );

  return r.rows.map((row): Conversation => {
    const isGroup = row.chat_id.toLowerCase().endsWith('@g.us');
    const debtorName = (row.owner_name || row.tenant_name || '').trim() || null;
    return {
      chat_id: row.chat_id,
      phone: isGroup ? null : chatIdToLocalPhone(row.chat_id) ?? row.contact_phone,
      is_group: isGroup,
      debtor_id: row.debtor_id,
      display_name: debtorName,
      apartment_number: row.apartment_number,
      last_content: row.last_content,
      last_type: row.last_type,
      last_direction: row.last_direction,
      last_at: row.last_at,
      unread: Number(row.unread ?? 0),
    };
  });
}

/**
 * One thread (a single chat_id), newest page first then reversed to chronological.
 * `before` is a created_at cursor for "load older" pagination.
 */
export async function listThread(
  chatId: string,
  before: string | null,
  limit = 50,
): Promise<ThreadMessage[]> {
  const r = await query<ThreadMessage>(
    `select
        m.id, m.debtor_id, m.contact_phone, m.chat_id, m.external_message_id,
        m.link_status, m.direction, m.message_type, m.content, m.media_url, m.status,
        m.error_detail, m.sent_by,
        u.full_name as sent_by_name,
        m.broadcast_id, m.read_at, m.created_at
       from public.chat_messages m
       left join public.users u on u.id = m.sent_by
      where m.chat_id = $1
        and ($2::timestamptz is null or m.created_at < $2::timestamptz)
      order by m.created_at desc
      limit $3`,
    [chatId, before, Math.max(1, Math.min(200, limit))],
  );
  // Reverse to chronological (oldest → newest) for rendering.
  return r.rows.reverse();
}

/** Mark every unread inbound message in a conversation as read. Returns the count. */
export async function markConversationRead(chatId: string): Promise<number> {
  const r = await query(
    `update public.chat_messages
        set read_at = now()
      where chat_id = $1 and direction = 'received' and read_at is null`,
    [chatId],
  );
  return r.rowCount ?? 0;
}

/** Total unread inbound messages across all conversations (nav badge). */
export async function countUnreadConversations(): Promise<number> {
  const r = await query<{ c: string }>(
    `select count(distinct chat_id)::text as c
       from public.chat_messages
      where direction = 'received' and read_at is null and chat_id is not null`,
  );
  return Number(r.rows[0]?.c ?? 0);
}

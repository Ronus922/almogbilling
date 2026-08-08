import 'server-only';
import { query } from '@/lib/db';
import { chatIdToLocalPhone } from '@/lib/whatsapp';
import type { Conversation, ThreadMessage } from '@/types/whatsapp';

// Conversation/thread queries for the /messages inbox. A conversation groups
// chat_messages by chat_id (the stable "<digits>@c.us" / "<id>@g.us" key shared
// by inbound + outbound rows). A conversation links to a debtor (matched at
// insert time by phone); the display identity resolves from that debtor's
// linked contacts row (registry), falling back to the frozen legacy debtors
// columns only when no contact is linked.

interface ConvRow {
  chat_id: string;
  contact_phone: string | null;
  debtor_id: string | null;
  supplier_id: string | null;
  supplier_display_name: string | null;
  last_content: string | null;
  last_type: Conversation['last_type'];
  last_direction: Conversation['last_direction'];
  last_at: string;
  unread: string;
  owner_name: string | null;
  tenant_name: string | null;
  apartment_number: string | null;
  role: 'owner' | 'tenant' | null;
  avatar_url: string | null;
}

/**
 * List conversations newest-first. Groups by chat_id; the most-recent message
 * supplies the preview.
 *
 * The linked debtor is resolved by a LATERAL join that prefers the stored
 * debtor_id but falls back to a NORMALIZED phone match (last 9 digits of the
 * chat_id, compared against both resident phone fields). This makes the name /
 * apartment display — and the name/apartment search — work even for
 * conversations whose rows predate the linking fix. A second join attaches the
 * cached profile picture (migration 019).
 *
 * `search` matches: debtor name (ILIKE), apartment number (ILIKE), or phone by
 * normalized digit substring (so "050…", "972…" and "53…" all hit).
 */
export async function listConversations(
  search = '',
  instanceId: string | null = null,
  limit = 200,
): Promise<Conversation[]> {
  const term = search.trim();
  const like = `%${term}%`;
  const digits = term.replace(/\D+/g, '');
  // Israeli local numbers carry a trunk "0" that the stored international form
  // ("972…") and the last-9 convkey both drop — so a user typing "0525460546"
  // must also match by the leading-zero-stripped form ("525460546").
  const digitsTrim = digits.replace(/^0+/, '');
  const r = await query<ConvRow>(
    `with convo as (
        select
          m.chat_id,
          max(m.created_at)                                                   as last_at,
          count(*) filter (where m.direction = 'received' and m.read_at is null) as unread,
          (array_agg(m.contact_phone order by m.created_at desc))[1]          as contact_phone,
          (array_agg(m.debtor_id order by m.created_at desc)
             filter (where m.debtor_id is not null))[1]                       as stored_debtor_id,
          (array_agg(m.supplier_id order by m.created_at desc)
             filter (where m.supplier_id is not null))[1]                     as supplier_id,
          (array_agg(coalesce(m.content, '') order by m.created_at desc))[1]  as last_content,
          (array_agg(m.message_type order by m.created_at desc))[1]          as last_type,
          (array_agg(m.direction order by m.created_at desc))[1]             as last_direction
        from public.chat_messages m
        where m.chat_id is not null
          and ($6::uuid is null or m.instance_id = $6::uuid)
        group by m.chat_id
     ),
     keyed as (
        select c.*,
          case
            when c.chat_id ilike '%@g.us%' then null
            -- Exactly phoneDigitsKey(): last 9 digits, but NULL when the stem has
            -- fewer than 9 digits (Postgres right(s,9) would otherwise return the
            -- whole short string, diverging from the JS helper).
            when length(regexp_replace(split_part(c.chat_id, '@', 1), '[^0-9]', '', 'g')) >= 9
              then right(regexp_replace(split_part(c.chat_id, '@', 1), '[^0-9]', '', 'g'), 9)
            else null
          end as convkey
        from convo c
     )
     select k.chat_id, k.contact_phone, k.last_content, k.last_type,
            k.last_direction, k.last_at, k.unread::text as unread,
            d.id as debtor_id, d.owner_name, d.tenant_name, d.apartment_number,
            k.supplier_id, sup.display_name as supplier_display_name,
            case
              when d.id is null or k.convkey is null then null
              when right(regexp_replace(coalesce(d.phone_owner,''),  '[^0-9]', '', 'g'), 9) = k.convkey then 'owner'
              when right(regexp_replace(coalesce(d.phone_tenant,''), '[^0-9]', '', 'g'), 9) = k.convkey then 'tenant'
              else null
            end as role,
            av.avatar_url
       from keyed k
       left join lateral (
          -- resident identity from contacts (registry); debtors columns are frozen legacy fallback (no linked contact only)
          select d.id,
                 case when rc.id is null then d.owner_name   else rc.owner_name   end as owner_name,
                 case when rc.id is null then d.tenant_name  else rc.tenant_name  end as tenant_name,
                 d.apartment_number,
                 case when rc.id is null then d.phone_owner  else rc.owner_phone  end as phone_owner,
                 case when rc.id is null then d.phone_tenant else rc.tenant_phone end as phone_tenant
            from public.debtors d
            left join public.contacts rc on rc.id = d.contact_id
           where (k.stored_debtor_id is not null and d.id = k.stored_debtor_id)
              -- Phone fallback ONLY when not supplier-linked: a supplier-linked
              -- conversation has debtor_id cleared (XOR), so it must not pick up a
              -- phantom debtor that happens to share the number.
              or (k.stored_debtor_id is null and k.supplier_id is null and k.convkey is not null
                  and (right(regexp_replace(coalesce(case when rc.id is null then d.phone_owner  else rc.owner_phone  end, ''), '[^0-9]', '', 'g'), 9) = k.convkey
                    or right(regexp_replace(coalesce(case when rc.id is null then d.phone_tenant else rc.tenant_phone end, ''), '[^0-9]', '', 'g'), 9) = k.convkey))
           order by d.is_archived asc, d.created_at asc
           limit 1
       ) d on true
       left join public.suppliers sup on sup.id = k.supplier_id
       left join public.whatsapp_avatars av on av.chat_id = k.chat_id
      where ($1 = ''
             or d.owner_name      ilike $2
             or d.tenant_name     ilike $2
             or d.apartment_number ilike $2
             or ($3 <> '' and regexp_replace(coalesce(k.contact_phone,''), '[^0-9]', '', 'g') like '%' || $3 || '%')
             or ($4 <> '' and regexp_replace(coalesce(k.contact_phone,''), '[^0-9]', '', 'g') like '%' || $4 || '%')
             or ($4 <> '' and k.convkey is not null and k.convkey like '%' || $4 || '%'))
      order by k.last_at desc
      limit $5`,
    [term, like, digits, digitsTrim, Math.max(1, Math.min(500, limit)), instanceId],
  );

  return r.rows.map((row): Conversation => {
    const isGroup = row.chat_id.toLowerCase().endsWith('@g.us');
    const debtorName = (row.owner_name || row.tenant_name || '').trim() || null;
    return {
      chat_id: row.chat_id,
      phone: isGroup ? null : chatIdToLocalPhone(row.chat_id) ?? row.contact_phone,
      is_group: isGroup,
      debtor_id: row.debtor_id,
      supplier_id: row.debtor_id ? null : row.supplier_id,
      supplier_display_name: row.debtor_id ? null : row.supplier_display_name,
      display_name: debtorName,
      apartment_number: row.apartment_number,
      role: row.debtor_id ? row.role : null,
      tenant_name: (row.tenant_name || '').trim() || null,
      last_content: row.last_content,
      last_type: row.last_type,
      last_direction: row.last_direction,
      last_at: row.last_at,
      unread: Number(row.unread ?? 0),
      avatar_url: row.avatar_url,
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
  instanceId: string | null = null,
  limit = 50,
): Promise<ThreadMessage[]> {
  const r = await query<ThreadMessage>(
    `select
        m.id, m.debtor_id, m.supplier_id, m.contact_phone, m.chat_id, m.external_message_id,
        m.link_status, m.direction, m.message_type, m.content, m.media_url, m.status,
        m.error_detail, m.sent_by,
        u.full_name as sent_by_name,
        s.display_name as supplier_display_name,
        m.broadcast_id, m.read_at, m.created_at
       from public.chat_messages m
       left join public.users u on u.id = m.sent_by
       left join public.suppliers s on s.id = m.supplier_id
      where m.chat_id = $1
        and ($2::timestamptz is null or m.created_at < $2::timestamptz)
        and ($4::uuid is null or m.instance_id = $4::uuid)
      order by m.created_at desc
      limit $3`,
    [chatId, before, Math.max(1, Math.min(200, limit)), instanceId],
  );
  // Reverse to chronological (oldest → newest) for rendering.
  return r.rows.reverse();
}

/** Mark every unread inbound message in a conversation as read. Returns the count.
 *  Scoped to an instance when provided (admins viewing a specific employee's inbox). */
export async function markConversationRead(chatId: string, instanceId: string | null = null): Promise<number> {
  const r = await query(
    `update public.chat_messages
        set read_at = now()
      where chat_id = $1 and direction = 'received' and read_at is null
        and ($2::uuid is null or instance_id = $2::uuid)`,
    [chatId, instanceId],
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

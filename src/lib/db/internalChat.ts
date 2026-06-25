import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import { createNotification } from '@/lib/db/notifications';
import type {
  ChatUnreadConversation,
  ChatUnreadSummary,
  ConversationSummary,
  InternalConversation,
  InternalMessage,
  ThreadPayload,
} from '@/lib/types/internalChat';
import { MAX_MESSAGE_LENGTH } from '@/lib/types/internalChat';

/** A client-input validation failure the route should surface as a 400. */
export class ChatValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ChatValidationError';
  }
}

/** Hard cap on group participants (incl. the creator) — bounds notification fan-out. */
export const MAX_GROUP_MEMBERS = 50;

// ── Eligibility ───────────────────────────────────────────────────────────

/**
 * Filter a set of requested user ids down to those eligible to be added to a
 * conversation: active users. (Every role holds internal_chat:view by default,
 * so "active user" is the chat-eligible set — mirrors listAssignableUsers().)
 * Returns only the ids that exist and are active — callers reject if any
 * requested id is dropped. Closes the forced-subscription vector: a caller
 * cannot inject arbitrary / guessed user ids into a conversation.
 */
export async function filterEligibleUserIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await query<{ id: string }>(
    `select id from public.users where id = any($1::uuid[]) and is_active = true`,
    [ids],
  );
  return new Set(r.rows.map((row) => row.id));
}

// ── Participant guard ─────────────────────────────────────────────────────

/**
 * True iff `userId` is a participant of `conversationId`. This is the single
 * authorization gate for every read/write on a conversation — callers MUST
 * check it (or rely on a query that filters by participant) before returning
 * any conversation data. Prevents IDOR.
 */
export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from public.internal_conversation_participants
      where conversation_id = $1 and user_id = $2
      limit 1`,
    [conversationId, userId],
  );
  return Boolean(row?.ok);
}

/** All participant user ids of a conversation (for typing fan-out scoping). */
export async function listParticipantIds(conversationId: string): Promise<string[]> {
  const r = await query<{ user_id: string }>(
    `select user_id from public.internal_conversation_participants where conversation_id = $1`,
    [conversationId],
  );
  return r.rows.map((row) => row.user_id);
}

// ── Presence ──────────────────────────────────────────────────────────────

/** How long after the last heartbeat a user still counts as "online". */
export const PRESENCE_WINDOW_SECONDS = 60;

/** Refresh the user's realtime-chat heartbeat (called on SSE connect + tick). */
export async function touchLastSeen(userId: string): Promise<void> {
  await query(`update public.users set last_seen_at = now() where id = $1`, [userId]);
}

// ── Conversation list (current-user perspective) ──────────────────────────

interface ConversationListRow {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  updated_at: string;
  last_message_content: string | null;
  last_message_at: string | null;
  unread_count: number;
  participant_names: string[];
  participant_count: number;
  other_names: string[];
  other_user_id: string | null;
  other_online: boolean;
}

/**
 * Conversations the user participates in, newest activity first. Includes the
 * last message preview, unread count (messages created after the user's
 * last_read_at, excluding their own), and participant display names.
 *
 * The outer query is anchored on `internal_conversation_participants` filtered
 * by `me` — so a conversation the user is NOT in can never appear, regardless
 * of the supplied conversation ids.
 */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const r = await query<ConversationListRow>(
    `
    select
      c.id,
      c.type,
      c.name,
      c.updated_at,
      lm.content        as last_message_content,
      lm.created_at     as last_message_at,
      coalesce(uc.unread_count, 0)::int as unread_count,
      coalesce(pn.names, '{}')          as participant_names,
      coalesce(pn.cnt, 0)::int          as participant_count,
      coalesce(onp.names, '{}')         as other_names,
      od.other_user_id                  as other_user_id,
      coalesce(od.online, false)        as other_online
    from public.internal_conversation_participants me
    join public.internal_conversations c on c.id = me.conversation_id
    -- last message in the conversation
    left join lateral (
      select m.content, m.created_at
        from public.internal_messages m
       where m.conversation_id = c.id
       order by m.created_at desc
       limit 1
    ) lm on true
    -- unread: messages after my last_read_at that I did not send
    left join lateral (
      select count(*) as unread_count
        from public.internal_messages m
       where m.conversation_id = c.id
         and m.created_at > me.last_read_at
         and (m.sender_user_id is distinct from $1)
    ) uc on true
    -- all participant display names + count
    left join lateral (
      select array_agg(coalesce(u.full_name, u.username) order by u.full_name nulls last) as names,
             count(*) as cnt
        from public.internal_conversation_participants p
        join public.users u on u.id = p.user_id
       where p.conversation_id = c.id
    ) pn on true
    -- other participants' names (for the direct-conversation title)
    left join lateral (
      select array_agg(coalesce(u.full_name, u.username) order by u.full_name nulls last) as names
        from public.internal_conversation_participants p
        join public.users u on u.id = p.user_id
       where p.conversation_id = c.id and p.user_id <> $1
    ) onp on true
    -- the single other participant of a DIRECT conversation + their online state
    left join lateral (
      select u.id as other_user_id,
             (u.last_seen_at is not null
              and u.last_seen_at > now() - interval '60 seconds') as online
        from public.internal_conversation_participants p
        join public.users u on u.id = p.user_id
       where p.conversation_id = c.id and p.user_id <> $1
       limit 1
    ) od on c.type = 'direct'
    where me.user_id = $1
    order by coalesce(lm.created_at, c.updated_at) desc
    `,
    [userId],
  );

  return r.rows.map((row) => {
    const title =
      row.type === 'group'
        ? (row.name?.trim() || 'קבוצה')
        : (row.other_names[0] ?? 'משתמש');
    return {
      id: row.id,
      type: row.type,
      title,
      participant_names: row.participant_names,
      participant_count: row.participant_count,
      last_message_content: row.last_message_content,
      last_message_at: row.last_message_at,
      unread_count: row.unread_count,
      other_user_id: row.other_user_id,
      online: row.type === 'direct' && row.other_online,
    } satisfies ConversationSummary;
  });
}

// ── Dashboard unread summary ──────────────────────────────────────────────

/**
 * Lean unread summary for the dashboard "internal messages" widget: total
 * unread across the user's conversations, how many conversations carry unread,
 * and the most-recent unread conversations (capped at `limit`). Same
 * participant-anchored / unread-cursor logic as listConversations, but trimmed
 * to the few fields the widget renders.
 */
export async function getChatUnreadSummary(
  userId: string,
  limit = 5,
): Promise<ChatUnreadSummary> {
  const r = await query<{
    id: string;
    type: 'direct' | 'group';
    name: string | null;
    last_message_content: string | null;
    last_message_at: string | null;
    unread_count: number;
    other_names: string[];
  }>(
    `
    select
      c.id,
      c.type,
      c.name,
      lm.content    as last_message_content,
      lm.created_at as last_message_at,
      uc.unread_count::int as unread_count,
      coalesce(onp.names, '{}') as other_names
    from public.internal_conversation_participants me
    join public.internal_conversations c on c.id = me.conversation_id
    left join lateral (
      select m.content, m.created_at
        from public.internal_messages m
       where m.conversation_id = c.id
       order by m.created_at desc
       limit 1
    ) lm on true
    join lateral (
      select count(*) as unread_count
        from public.internal_messages m
       where m.conversation_id = c.id
         and m.created_at > me.last_read_at
         and (m.sender_user_id is distinct from $1)
    ) uc on true
    left join lateral (
      select array_agg(coalesce(u.full_name, u.username) order by u.full_name nulls last) as names
        from public.internal_conversation_participants p
        join public.users u on u.id = p.user_id
       where p.conversation_id = c.id and p.user_id <> $1
    ) onp on true
    where me.user_id = $1
      and uc.unread_count > 0
    order by lm.created_at desc nulls last
    `,
    [userId],
  );

  const total = r.rows.reduce((s, row) => s + row.unread_count, 0);
  const conversations: ChatUnreadConversation[] = r.rows.slice(0, limit).map((row) => ({
    id: row.id,
    title:
      row.type === 'group' ? (row.name?.trim() || 'קבוצה') : (row.other_names[0] ?? 'משתמש'),
    last_message_content: row.last_message_content,
    last_message_at: row.last_message_at,
    unread_count: row.unread_count,
  }));

  return { total, conversation_count: r.rows.length, conversations };
}

// ── Create / find conversations ───────────────────────────────────────────

/**
 * Find an existing direct (1:1) conversation between exactly `userA` and
 * `userB`. Returns its id, or null. Used to dedupe — a direct conversation
 * between two users is unique.
 */
export async function findExistingDirect(userA: string, userB: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `
    select c.id
      from public.internal_conversations c
     where c.type = 'direct'
       and exists (select 1 from public.internal_conversation_participants p
                    where p.conversation_id = c.id and p.user_id = $1)
       and exists (select 1 from public.internal_conversation_participants p
                    where p.conversation_id = c.id and p.user_id = $2)
       and (select count(*) from public.internal_conversation_participants p
             where p.conversation_id = c.id) = 2
     limit 1
    `,
    [userA, userB],
  );
  return row?.id ?? null;
}

/**
 * Create a direct conversation between the creator and one other user. If one
 * already exists it is returned instead (no duplicate). Both participant rows
 * are inserted in a single transaction.
 */
export async function createDirectConversation(
  creatorId: string,
  creatorName: string | null,
  otherUserId: string,
): Promise<{ id: string; existed: boolean }> {
  // Eligibility: the target must be an existing active user.
  const eligible = await filterEligibleUserIds([otherUserId]);
  if (!eligible.has(otherUserId)) {
    throw new ChatValidationError('ineligible_user');
  }

  const existing = await findExistingDirect(creatorId, otherUserId);
  if (existing) return { id: existing, existed: true };

  return withTransaction(async (client) => {
    // Re-check inside the transaction to narrow the create/create race window.
    const dup = await client.query<{ id: string }>(
      `
      select c.id
        from public.internal_conversations c
       where c.type = 'direct'
         and exists (select 1 from public.internal_conversation_participants p
                      where p.conversation_id = c.id and p.user_id = $1)
         and exists (select 1 from public.internal_conversation_participants p
                      where p.conversation_id = c.id and p.user_id = $2)
         and (select count(*) from public.internal_conversation_participants p
               where p.conversation_id = c.id) = 2
       limit 1
      `,
      [creatorId, otherUserId],
    );
    if (dup.rows[0]) return { id: dup.rows[0].id, existed: true };

    const conv = await client.query<{ id: string }>(
      `insert into public.internal_conversations (type, created_by, created_by_name)
       values ('direct', $1, $2)
       returning id`,
      [creatorId, creatorName],
    );
    const id = conv.rows[0].id;
    await client.query(
      `insert into public.internal_conversation_participants (conversation_id, user_id)
       values ($1, $2), ($1, $3)`,
      [id, creatorId, otherUserId],
    );
    return { id, existed: false };
  });
}

/**
 * Create a group conversation. `memberIds` are the OTHER members; the creator
 * is always added. Duplicate ids are collapsed.
 */
export async function createGroupConversation(
  creatorId: string,
  creatorName: string | null,
  name: string,
  memberIds: string[],
): Promise<{ id: string }> {
  // Eligibility: every requested member must be an existing active user — a
  // caller cannot inject arbitrary / guessed user ids into a group.
  const requested = Array.from(new Set(memberIds));
  const eligible = await filterEligibleUserIds(requested);
  if (requested.some((id) => !eligible.has(id))) {
    throw new ChatValidationError('ineligible_user');
  }

  // Unique participant set including the creator.
  const all = Array.from(new Set([creatorId, ...requested]));
  if (all.length > MAX_GROUP_MEMBERS) {
    throw new ChatValidationError('too_many_members');
  }

  return withTransaction(async (client) => {
    const conv = await client.query<{ id: string }>(
      `insert into public.internal_conversations (type, name, created_by, created_by_name)
       values ('group', $1, $2, $3)
       returning id`,
      [name, creatorId, creatorName],
    );
    const id = conv.rows[0].id;
    // Parameterised multi-row insert.
    const values = all.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `insert into public.internal_conversation_participants (conversation_id, user_id)
       values ${values}
       on conflict (conversation_id, user_id) do nothing`,
      [id, ...all],
    );
    return { id };
  });
}

// ── Thread (messages) ──────────────────────────────────────────────────────

/** Resolve a conversation's display header for the current user. */
async function getConversationHeader(
  conversationId: string,
  userId: string,
): Promise<ThreadPayload['conversation'] | null> {
  const conv = await queryOne<Pick<InternalConversation, 'id' | 'type' | 'name'>>(
    `select id, type, name from public.internal_conversations where id = $1 limit 1`,
    [conversationId],
  );
  if (!conv) return null;

  const namesRes = await query<{
    user_id: string;
    name: string;
    is_me: boolean;
    online: boolean;
    last_read_at: string | null;
    last_seen_at: string | null;
  }>(
    `select p.user_id,
            coalesce(u.full_name, u.username) as name,
            (p.user_id = $2) as is_me,
            (u.last_seen_at is not null
             and u.last_seen_at > now() - interval '60 seconds') as online,
            p.last_read_at,
            u.last_seen_at
       from public.internal_conversation_participants p
       join public.users u on u.id = p.user_id
      where p.conversation_id = $1
      order by u.full_name nulls last`,
    [conversationId, userId],
  );
  const participant_names = namesRes.rows.map((x) => x.name);
  const others = namesRes.rows.filter((x) => !x.is_me);
  const title =
    conv.type === 'group' ? (conv.name?.trim() || 'קבוצה') : (others[0]?.name ?? 'משתמש');
  // Presence + receipts are direct-conversation concepts (one "other"); groups
  // don't show them.
  const other = conv.type === 'direct' ? (others[0] ?? null) : null;

  return {
    id: conv.id,
    type: conv.type,
    title,
    participant_names,
    other_user_id: other?.user_id ?? null,
    online: other?.online ?? false,
    other_last_read_at: other?.last_read_at ?? null,
    other_last_seen_at: other?.last_seen_at ?? null,
  };
}

/**
 * Return the thread for a conversation the user participates in. `sinceIso`,
 * when provided, returns only messages strictly newer than it (the polling
 * delta). Also advances the user's read cursor to now (marks read).
 *
 * Returns null when the user is NOT a participant — the caller maps that to 403.
 */
export async function getThreadForParticipant(
  conversationId: string,
  userId: string,
  sinceIso: string | null,
): Promise<ThreadPayload | null> {
  if (!(await isParticipant(conversationId, userId))) return null;

  const header = await getConversationHeader(conversationId, userId);
  if (!header) return null;

  const params: unknown[] = [conversationId];
  let sinceClause = '';
  if (sinceIso) {
    params.push(sinceIso);
    // The client echoes back a created_at it received as JSON — which carries
    // only millisecond precision (e.g. ".162Z"), while the column stores
    // microseconds (".162102"). Comparing raw would re-return the boundary
    // message (".162102" > ".162000"). Truncate the column to milliseconds so
    // the comparison aligns exactly with what the client actually saw.
    sinceClause = `and date_trunc('milliseconds', m.created_at) > $2::timestamptz`;
  }
  const msgs = await query<InternalMessage>(
    `select m.id, m.conversation_id, m.sender_user_id, m.sender_name, m.content, m.created_at
       from public.internal_messages m
      where m.conversation_id = $1 ${sinceClause}
      order by m.created_at asc`,
    params,
  );

  // Advance the read cursor (mark everything up to now as read for this user).
  await markRead(conversationId, userId);

  return { conversation: header, messages: msgs.rows };
}

/** Advance the participant's last_read_at to now. No-op if not a participant. */
export async function markRead(conversationId: string, userId: string): Promise<void> {
  await query(
    `update public.internal_conversation_participants
        set last_read_at = now()
      where conversation_id = $1 and user_id = $2`,
    [conversationId, userId],
  );
}

/**
 * Append a message to a conversation the user participates in, then fan out an
 * in-app notification to every OTHER participant (deduped to one per
 * conversation per day so an active back-and-forth doesn't spam). All in one
 * transaction. Returns the created message, or null when the user is NOT a
 * participant (caller maps to 403).
 */
export async function postMessage(
  conversationId: string,
  sender: { id: string; name: string | null },
  rawContent: string,
): Promise<InternalMessage | null> {
  const content = rawContent.trim();
  if (content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
    throw new Error('invalid_content');
  }
  if (!(await isParticipant(conversationId, sender.id))) return null;

  return withTransaction(async (client) => {
    const inserted = await client.query<InternalMessage>(
      `insert into public.internal_messages
         (conversation_id, sender_user_id, sender_name, content)
       values ($1, $2, $3, $4)
       returning id, conversation_id, sender_user_id, sender_name, content, created_at`,
      [conversationId, sender.id, sender.name, content],
    );
    const message = inserted.rows[0];

    // Bump conversation activity (drives list ordering / fallback timestamp).
    await client.query(
      `update public.internal_conversations set updated_at = now() where id = $1`,
      [conversationId],
    );

    // Notify other participants (in-app, deduped per conversation per day).
    const recipients = await client.query<{ user_id: string }>(
      `select user_id
         from public.internal_conversation_participants
        where conversation_id = $1 and user_id <> $2`,
      [conversationId, sender.id],
    );

    const header = await getConversationHeader(conversationId, sender.id);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const senderLabel = sender.name?.trim() || 'משתמש';
    const title =
      header?.type === 'group'
        ? `הודעה חדשה בקבוצה ${header.title}`
        : `הודעה חדשה מ${senderLabel}`;
    const preview = content.length > 80 ? content.slice(0, 80) + '…' : content;

    for (const r of recipients.rows) {
      await createNotification(
        {
          userId: r.user_id,
          type: 'internal_chat_message',
          title,
          message: preview,
          sourceModule: 'internal_chat',
          sourceEntityType: 'conversation',
          sourceEntityId: conversationId,
          actionUrl: `/chat?c=${conversationId}`,
          priority: 'normal',
          // One alert per recipient per conversation per day until they read it.
          dedupeKey: `internal_chat:${conversationId}:${r.user_id}:${today}`,
        },
        client,
      );
    }

    return message;
  });
}

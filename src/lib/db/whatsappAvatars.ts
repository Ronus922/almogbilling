import 'server-only';
import { query } from '@/lib/db';

// Cache layer for WhatsApp profile pictures (migration 019). Green API's
// getAvatar returns an EXPIRING CDN url, so we store the last-fetched value
// (plus a NULL "checked, no picture" marker) and refresh lazily on a 3-day
// window — never on every conversation-list render.

/** Upsert a conversation's avatar. Pass null to cache "no picture available"
 *  (fetched_at is bumped either way so we don't re-probe immediately). */
export async function upsertAvatar(chatId: string, avatarUrl: string | null): Promise<void> {
  await query(
    `insert into public.whatsapp_avatars (chat_id, avatar_url, fetched_at)
     values ($1, $2, now())
     on conflict (chat_id) do update
       set avatar_url = excluded.avatar_url,
           fetched_at = now()`,
    [chatId, avatarUrl],
  );
}

/**
 * From a set of conversation chat_ids, return the ones whose avatar is stale —
 * no cached row at all, or a row older than `maxAgeDays`. Capped at `limit` so a
 * single conversations request never fans out into more than a few Green API
 * calls; the inbox's 5s polling fills the rest in over subsequent requests.
 */
export async function listStaleAvatarChats(
  chatIds: string[],
  limit = 5,
  maxAgeDays = 3,
): Promise<string[]> {
  if (chatIds.length === 0) return [];
  const r = await query<{ chat_id: string }>(
    `select c.chat_id
       from unnest($1::text[]) as c(chat_id)
       left join public.whatsapp_avatars a on a.chat_id = c.chat_id
      where a.chat_id is null
         or a.fetched_at < now() - make_interval(days => $2)
      limit $3`,
    [chatIds, maxAgeDays, Math.max(1, Math.min(20, limit))],
  );
  return r.rows.map((x) => x.chat_id);
}

import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { PoolClient } from 'pg';
import type { CreateNotificationInput, Notification } from '@/lib/types/tasks';

const COLUMNS = `
  id, user_id, type, title, message, is_read,
  source_module, source_entity_type, source_entity_id,
  action_url, priority, dedupe_key, created_at, updated_at
`;

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Insert a notification. When dedupeKey is supplied we ON CONFLICT DO NOTHING
 * against the partial unique index — a repeated assignment won't spam the user.
 * Returns the created row, or null when it was deduped away.
 *
 * Accepts an optional pg client so it can participate in a withTransaction().
 */
export async function createNotification(
  input: CreateNotificationInput,
  client?: Queryable,
): Promise<Notification | null> {
  const params = [
    input.userId,
    input.type,
    input.title,
    input.message ?? null,
    input.sourceModule ?? null,
    input.sourceEntityType ?? null,
    input.sourceEntityId ?? null,
    input.actionUrl ?? null,
    input.priority ?? 'normal',
    input.dedupeKey ?? null,
  ];
  const sql = `
    insert into public.notifications
      (user_id, type, title, message, source_module, source_entity_type,
       source_entity_id, action_url, priority, dedupe_key)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning ${COLUMNS}
  `;
  if (client) {
    const r = await client.query<Notification>(sql, params);
    return r.rows[0] ?? null;
  }
  return queryOne<Notification>(sql, params);
}

export async function listNotifications(
  userId: string,
  opts: { limit?: number; onlyUnread?: boolean } = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = opts.onlyUnread ? 'and is_read = false' : '';
  const r = await query<Notification>(
    `select ${COLUMNS}
       from public.notifications
      where user_id = $1 ${where}
      order by created_at desc
      limit ${limit}`,
    [userId],
  );
  return r.rows;
}

export async function countUnread(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::int as count
       from public.notifications
      where user_id = $1 and is_read = false`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

/** Mark a single notification read — scoped to the owner (returns false if not theirs). */
export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  const r = await query(
    `update public.notifications
        set is_read = true
      where id = $1 and user_id = $2 and is_read = false`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const r = await query(
    `update public.notifications
        set is_read = true
      where user_id = $1 and is_read = false`,
    [userId],
  );
  return r.rowCount ?? 0;
}

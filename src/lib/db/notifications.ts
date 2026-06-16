import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { PoolClient } from 'pg';
import type { CreateNotificationInput, Notification } from '@/lib/types/tasks';

const COLUMNS = `
  id, user_id, type, title, message, is_read, read_at, cleared_at,
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

/**
 * The panel/active stream — always scoped to the owner and to the ACTIVE rows
 * (cleared_at IS NULL). `onlyUnread` narrows to the "unread" tab; `module`
 * narrows to a source-module tab. Soft-cleared rows never appear here.
 */
export async function listNotifications(
  userId: string,
  opts: { limit?: number; onlyUnread?: boolean; module?: string } = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const conds = ['user_id = $1', 'cleared_at is null'];
  const params: unknown[] = [userId];
  if (opts.onlyUnread) conds.push('is_read = false');
  if (opts.module) { params.push(opts.module); conds.push(`source_module = $${params.length}`); }
  const r = await query<Notification>(
    `select ${COLUMNS}
       from public.notifications
      where ${conds.join(' and ')}
      order by created_at desc
      limit ${limit}`,
    params,
  );
  return r.rows;
}

/** Active unread count (is_read=false AND cleared_at IS NULL) — drives the bell
 *  badge and the "לא נקראו" tab badge. */
export async function countUnread(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::int as count
       from public.notifications
      where user_id = $1 and is_read = false and cleared_at is null`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

/** Mark a single notification read — scoped to the owner (returns false if not theirs). */
export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  const r = await query(
    `update public.notifications
        set is_read = true, read_at = now()
      where id = $1 and user_id = $2 and is_read = false`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Owner-scoped single mark-read for PATCH /[id]/read. Unlike markNotificationRead
 * this matches the row regardless of its current read state, so an already-read
 * owned row still counts as success (read_at preserved via coalesce). Returns
 * false ONLY when the row doesn't exist OR isn't the caller's → the route maps
 * that to 404.
 */
export async function markNotificationReadOwned(id: string, userId: string): Promise<boolean> {
  const r = await query(
    `update public.notifications
        set is_read = true, read_at = coalesce(read_at, now())
      where id = $1 and user_id = $2
      returning id`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Mark every ACTIVE unread notification read (the cleared ones are already out
 *  of every tab, so they're left untouched). */
export async function markAllNotificationsRead(userId: string): Promise<number> {
  const r = await query(
    `update public.notifications
        set is_read = true, read_at = now()
      where user_id = $1 and is_read = false and cleared_at is null`,
    [userId],
  );
  return r.rowCount ?? 0;
}

/**
 * Soft-clear every active notification of the user (cleared_at = now()). The
 * rows stay in the DB — for audit and for dedup (a re-emitted notification with
 * the same dedupe_key still ON CONFLICT DO NOTHING) — but vanish from every tab
 * including "הכל". NEVER a hard delete. Returns how many were cleared.
 */
export async function clearAllNotifications(userId: string): Promise<number> {
  const r = await query(
    `update public.notifications
        set cleared_at = now()
      where user_id = $1 and cleared_at is null`,
    [userId],
  );
  return r.rowCount ?? 0;
}

/**
 * Soft-clear ONE notification (cleared_at = now()) — scoped to the owner. Like
 * clearAllNotifications but for a single row: it stays in the DB (audit + dedup)
 * yet vanishes from every tab. Ownership is enforced in the WHERE clause; returns
 * false when the row doesn't exist, isn't the caller's, or was already cleared.
 * NEVER a hard delete.
 */
export async function clearNotification(id: string, userId: string): Promise<boolean> {
  const r = await query(
    `update public.notifications
        set cleared_at = now()
      where id = $1 and user_id = $2 and cleared_at is null`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface NotificationPageFilters {
  module?: string;
  priority?: string;
  /** true → only unread; false → only read; undefined → all. */
  unread?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * Filtered + paginated list for the /notifications page — always scoped to the
 * owner. Returns the page slice + the total matching count (for pagination).
 */
export async function listNotificationsPage(
  userId: string,
  filters: NotificationPageFilters = {},
): Promise<{ items: Notification[]; total: number }> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(Math.max(Math.trunc(filters.pageSize ?? 20), 1), 100);
  const offset = (page - 1) * pageSize;

  // Always scoped to the ACTIVE stream — cleared rows are hidden from the page
  // too. read items stay visible (the read/unread filter gives history).
  const conds = ['user_id = $1', 'cleared_at is null'];
  const params: unknown[] = [userId];
  if (filters.module) { params.push(filters.module); conds.push(`source_module = $${params.length}`); }
  if (filters.priority) { params.push(filters.priority); conds.push(`priority = $${params.length}`); }
  if (filters.unread === true) conds.push('is_read = false');
  else if (filters.unread === false) conds.push('is_read = true');
  const where = conds.join(' and ');

  const countRow = await queryOne<{ count: string }>(
    `select count(*)::int as count from public.notifications where ${where}`,
    params,
  );
  const total = Number(countRow?.count ?? 0);

  const r = await query<Notification>(
    `select ${COLUMNS}
       from public.notifications
      where ${where}
      order by created_at desc
      limit ${pageSize} offset ${offset}`,
    params,
  );
  return { items: r.rows, total };
}

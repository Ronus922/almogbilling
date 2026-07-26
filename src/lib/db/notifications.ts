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

/** source_modules that each own a dedicated header dropdown (WhatsApp chat,
 *  internal chat). The bell shows everything EXCEPT these; each one is its own
 *  surface. Keeping them as constants guarantees the three stay disjoint — no
 *  notification is ever counted in more than one. */
export const WHATSAPP_MODULE = 'whatsapp';
export const INTERNAL_CHAT_MODULE = 'internal_chat';
export const DEDICATED_MODULES = [WHATSAPP_MODULE, INTERNAL_CHAT_MODULE];

/** Narrows a query to one source_module, or to everything EXCEPT a set of them.
 *  Used to keep the bell (excludeModules) and each dedicated dropdown (module)
 *  disjoint. The `is null or <> all(...)` form keeps NULL-module legacy rows in
 *  the bell (a bare `<> all` on NULL is unknown → would drop them). */
export interface ModuleScope {
  module?: string;
  excludeModules?: string[];
}

function applyModuleScope(scope: ModuleScope, conds: string[], params: unknown[]): void {
  if (scope.module) {
    params.push(scope.module);
    conds.push(`source_module = $${params.length}`);
  }
  if (scope.excludeModules?.length) {
    params.push(scope.excludeModules);
    conds.push(`(source_module is null or source_module <> all($${params.length}::text[]))`);
  }
}

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
  opts: { limit?: number; onlyUnread?: boolean } & ModuleScope = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const conds = ['user_id = $1', 'cleared_at is null'];
  const params: unknown[] = [userId];
  if (opts.onlyUnread) conds.push('is_read = false');
  applyModuleScope(opts, conds, params);
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
 *  badge and the "לא נקראו" tab badge. An optional ModuleScope partitions it for
 *  the bell (excludeModules) vs a dedicated dropdown (module). */
export async function countUnread(userId: string, scope: ModuleScope = {}): Promise<number> {
  const conds = ['user_id = $1', 'is_read = false', 'cleared_at is null'];
  const params: unknown[] = [userId];
  applyModuleScope(scope, conds, params);
  const row = await queryOne<{ count: string }>(
    `select count(*)::int as count
       from public.notifications
      where ${conds.join(' and ')}`,
    params,
  );
  return Number(row?.count ?? 0);
}

/** All three header badge counts in ONE snapshot: `bell` (every active unread
 *  EXCEPT the dedicated modules), `whatsapp` (active unread WhatsApp) and
 *  `internalChat` (active unread internal chat). A single FILTER query so the
 *  three surfaces partition the same rows atomically — a notification lands in
 *  exactly one bucket, never double-counted. */
export async function countUnreadSplit(
  userId: string,
): Promise<{ bell: number; whatsapp: number; internalChat: number }> {
  const row = await queryOne<{ bell: string; whatsapp: string; internal_chat: string }>(
    `select
        count(*) filter (where source_module is null or source_module <> all($2::text[]))::int as bell,
        count(*) filter (where source_module = $3)::int as whatsapp,
        count(*) filter (where source_module = $4)::int as internal_chat
       from public.notifications
      where user_id = $1 and is_read = false and cleared_at is null`,
    [userId, DEDICATED_MODULES, WHATSAPP_MODULE, INTERNAL_CHAT_MODULE],
  );
  return {
    bell: Number(row?.bell ?? 0),
    whatsapp: Number(row?.whatsapp ?? 0),
    internalChat: Number(row?.internal_chat ?? 0),
  };
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
 *  of every tab, so they're left untouched). An optional ModuleScope limits it to
 *  the bell surface (excludeModules) or a dedicated dropdown (module) so each
 *  surface's "mark all read" never clears another's badge. */
export async function markAllNotificationsRead(
  userId: string,
  scope: ModuleScope = {},
): Promise<number> {
  const conds = ['user_id = $1', 'is_read = false', 'cleared_at is null'];
  const params: unknown[] = [userId];
  applyModuleScope(scope, conds, params);
  const r = await query(
    `update public.notifications
        set is_read = true, read_at = now()
      where ${conds.join(' and ')}`,
    params,
  );
  return r.rowCount ?? 0;
}

/**
 * Soft-clear every active notification of the user (cleared_at = now()). The
 * rows stay in the DB — for audit and for dedup (a re-emitted notification with
 * the same dedupe_key still ON CONFLICT DO NOTHING) — but vanish from every tab
 * including "הכל". NEVER a hard delete. Returns how many were cleared.
 */
export async function clearAllNotifications(
  userId: string,
  scope: ModuleScope = {},
): Promise<number> {
  const conds = ['user_id = $1', 'cleared_at is null'];
  const params: unknown[] = [userId];
  applyModuleScope(scope, conds, params);
  const r = await query(
    `update public.notifications
        set cleared_at = now()
      where ${conds.join(' and ')}`,
    params,
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

/**
 * Hard-delete every notification pointing at a given entity — the mirror of
 * deleteRemindersForEntity, called from the DELETE routes so a removed task /
 * issue leaves no ghost notification in the bell. Matched case-insensitively:
 * every producer now writes lower_snake_case (see CreateNotificationInput), but
 * rows written before that still carry 'Task'/'Issue'/'ChatMessage', so the
 * lower() on both sides must stay until those are normalized. The entity is
 * gone, so a hard delete is correct — no audit target, no dedup key to
 * preserve. Accepts an optional pg client for txns.
 */
export async function deleteNotificationsForEntity(
  entityType: string,
  entityId: string,
  client?: Queryable,
): Promise<void> {
  const sql = `delete from public.notifications
     where lower(source_entity_type) = lower($1) and source_entity_id = $2`;
  if (client) {
    await client.query(sql, [entityType, entityId]);
    return;
  }
  await query(sql, [entityType, entityId]);
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

import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  UserReminder,
  UserReminderListFilters,
  UserReminderWithNames,
  UserReminderWritableFields,
} from '@/lib/types/userReminders';

// timestamptz columns are cast to text so they cross the RSC boundary as strings
// (matching the declared `string` types) — pg otherwise returns Date objects,
// which crash when rendered in JSX. Mirrors the tasks module convention.
const COLUMNS = `
  id, title, description, remind_at::text as remind_at, status,
  entity_type, entity_id, assigned_to, created_by, category_id,
  completed_at::text as completed_at, is_archived,
  created_at::text as created_at, updated_at::text as updated_at
`;

// Columns a create/update may set (created_by handled explicitly on create;
// completed_at is derived from status server-side, never client-writable).
const WRITABLE_COLUMNS: (keyof UserReminderWritableFields)[] = [
  'title',
  'description',
  'remind_at',
  'status',
  'entity_type',
  'entity_id',
  'assigned_to',
  'category_id',
];

function prefixed(alias: string): string {
  return COLUMNS.split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}

// ── List ──────────────────────────────────────────────────────────────────
export async function listUserReminders(
  filters: UserReminderListFilters,
): Promise<UserReminderWithNames[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (!filters.includeArchived) {
    where.push('r.is_archived = false');
  }
  if (filters.status) {
    vals.push(filters.status);
    where.push(`r.status = $${vals.length}`);
  }
  if (filters.assignedTo) {
    vals.push(filters.assignedTo);
    where.push(`r.assigned_to = $${vals.length}`);
  }
  if (filters.createdBy) {
    vals.push(filters.createdBy);
    where.push(`r.created_by = $${vals.length}`);
  }
  if (filters.involvingUser) {
    vals.push(filters.involvingUser);
    where.push(`(r.created_by = $${vals.length} or r.assigned_to = $${vals.length})`);
  }
  if (filters.categoryId) {
    vals.push(filters.categoryId);
    where.push(`r.category_id = $${vals.length}`);
  }
  if (filters.entityType) {
    vals.push(filters.entityType);
    where.push(`r.entity_type = $${vals.length}`);
  }
  if (filters.entityId) {
    vals.push(filters.entityId);
    where.push(`r.entity_id = $${vals.length}`);
  }
  if (filters.due) {
    // Overdue and still pending — the "needs attention" view.
    where.push(`r.remind_at < now() and r.status = 'pending'`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';

  // The listing user's own drag order (06/10/2026): their rows of
  // user_reminder_order first, in position order; the undragged ones after,
  // by remind_at as always; the id last so equal times are stable.
  let orderJoin = '';
  let positionSql = 'null::integer as position';
  let orderBy = 'r.remind_at asc, r.id asc';
  if (filters.orderForUser) {
    vals.push(filters.orderForUser);
    orderJoin = `left join public.user_reminder_order o on o.reminder_id = r.id and o.user_id = $${vals.length}`;
    positionSql = 'o.position as position';
    orderBy = 'o.position asc nulls last, r.remind_at asc, r.id asc';
  }

  const r = await query<UserReminderWithNames>(
    `select ${prefixed('r')},
            ua.full_name as assigned_to_name,
            coalesce(uc.full_name, r.created_by_name) as created_by_name,
            cat.name as category_name,
            cat.color as category_color,
            ${positionSql}
       from public.user_reminders r
       left join public.users ua on ua.id = r.assigned_to
       left join public.users uc on uc.id = r.created_by
       left join public.reminder_categories cat on cat.id = r.category_id
       ${orderJoin}
       ${whereSql}
       order by ${orderBy}`,
    vals,
  );
  return r.rows;
}

// ── Per-user order ───────────────────────────────────────────────────────────
export type SetOrderResult = 'ok' | 'not_found' | 'forbidden';

/**
 * Where `userId` placed these reminders in their own list, top to bottom:
 * position 0..n-1 for exactly these ids, upserted — rows of ids not in the
 * list are left as they are, and nobody else's rows are touched (the order is
 * per user, 06/10/2026). Every id must be a live reminder the user is involved
 * in (created by them or assigned to them): an unknown or archived id is
 * 'not_found', someone else's is 'forbidden', and then nothing is written.
 */
export async function setUserReminderOrder(userId: string, ids: readonly string[]): Promise<SetOrderResult> {
  if (ids.length === 0) return 'ok';
  return withTransaction(async (client: PoolClient) => {
    const found = await client.query<{ id: string; involved: boolean }>(
      `select id, (created_by = $1 or assigned_to = $1) as involved
         from public.user_reminders
        where id = any($2::uuid[]) and is_archived = false`,
      [userId, ids],
    );
    if (found.rowCount !== ids.length) return 'not_found';
    if (found.rows.some((r) => !r.involved)) return 'forbidden';

    await client.query(
      `insert into public.user_reminder_order (user_id, reminder_id, position)
       select $1, x.id, x.pos
         from unnest($2::uuid[], $3::integer[]) as x(id, pos)
       on conflict (user_id, reminder_id) do update set position = excluded.position`,
      [userId, ids, ids.map((_, i) => i)],
    );
    return 'ok';
  });
}

/**
 * Pending reminders the given user is involved in (created_by OR assigned_to),
 * whose remind_at falls on a local day inside [from, to] (inclusive) — for the
 * calendar's read-only reminder overlay. from/to are 'YYYY-MM-DD'.
 *
 * remind_at is a timestamptz (a single instant); we convert it to the local wall
 * clock in Asia/Jerusalem (the project tz, matching the reminders cron) to derive
 * the calendar day + HH:MM. A reminder always carries a time, so it is never an
 * all-day item. Archived / done / dismissed reminders are excluded.
 */
export async function listUserRemindersInRange(
  from: string,
  to: string,
  userId: string,
): Promise<{ id: string; title: string; event_date: string; due_time: string; status: string }[]> {
  const r = await query<{
    id: string;
    title: string;
    event_date: string;
    due_time: string;
    status: string;
  }>(
    `select id, title,
            to_char(remind_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as event_date,
            to_char(remind_at at time zone 'Asia/Jerusalem', 'HH24:MI') as due_time,
            status
       from public.user_reminders
      where is_archived = false
        and status = 'pending'
        and (created_by = $3 or assigned_to = $3)
        and (remind_at at time zone 'Asia/Jerusalem')::date >= $1
        and (remind_at at time zone 'Asia/Jerusalem')::date <= $2
      order by remind_at asc`,
    [from, to, userId],
  );
  return r.rows;
}

export async function getUserReminderById(id: string): Promise<UserReminderWithNames | null> {
  return queryOne<UserReminderWithNames>(
    `select ${prefixed('r')},
            ua.full_name as assigned_to_name,
            coalesce(uc.full_name, r.created_by_name) as created_by_name,
            cat.name as category_name,
            cat.color as category_color,
            null::integer as position
       from public.user_reminders r
       left join public.users ua on ua.id = r.assigned_to
       left join public.users uc on uc.id = r.created_by
       left join public.reminder_categories cat on cat.id = r.category_id
      where r.id = $1
      limit 1`,
    [id],
  );
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createUserReminder(
  data: Partial<UserReminderWritableFields> & { title: string; remind_at: string },
  createdBy: string,
): Promise<UserReminder> {
  const rec = data as Record<string, unknown>;
  const cols: string[] = ['created_by'];
  const vals: unknown[] = [createdBy];

  for (const c of WRITABLE_COLUMNS) {
    if (c in rec && rec[c] !== undefined) {
      cols.push(c);
      vals.push(rec[c]);
    }
  }

  // completed_at: stamp when created already 'done' (default is 'pending').
  if ((data.status ?? 'pending') === 'done') {
    cols.push('completed_at');
    vals.push(new Date().toISOString());
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`);
  // The creator's name as text beside the id ($1): the assignee keeps seeing
  // who wrote the reminder after that user is deleted (06/10/2026).
  cols.push('created_by_name');
  placeholders.push('(select coalesce(u.full_name, u.username) from public.users u where u.id = $1)');
  const row = await queryOne<UserReminder>(
    `insert into public.user_reminders (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${COLUMNS}`,
    vals,
  );
  if (!row) throw new Error('failed_to_create_user_reminder');
  return row;
}

// ── Update ──────────────────────────────────────────────────────────────────
export async function updateUserReminder(
  id: string,
  data: Partial<UserReminderWritableFields> & { is_archived?: boolean },
): Promise<UserReminder | null> {
  const rec = { ...data } as Record<string, unknown>;
  const set: string[] = [];
  const vals: unknown[] = [id];

  const updatable = [...WRITABLE_COLUMNS, 'is_archived' as const];
  for (const c of updatable) {
    if (c in rec && rec[c] !== undefined) {
      vals.push(rec[c]);
      set.push(`${c} = $${vals.length}`);
    }
  }

  // completed_at follows status. Bare `status` / `completed_at` reference the
  // OLD row values (Postgres UPDATE semantics): entering 'done' stamps now()
  // (keeping an existing time if already done); any other status clears it.
  if ('status' in rec && rec.status !== undefined) {
    set.push(
      rec.status === 'done'
        ? `completed_at = case when status is distinct from 'done' then now() else completed_at end`
        : `completed_at = null`,
    );
  }

  if (set.length === 0) {
    const existing = await getUserReminderById(id);
    return existing as UserReminder | null;
  }

  return queryOne<UserReminder>(
    `update public.user_reminders set ${set.join(', ')} where id = $1 returning ${COLUMNS}`,
    vals,
  );
}

// ── Soft-delete ──────────────────────────────────────────────────────────────
/**
 * Soft-delete: archive the reminder (is_archived = true) — consistent with the
 * tasks module. The row is retained. Idempotent. Returns false only when the id
 * doesn't exist.
 */
export async function softDeleteUserReminder(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update public.user_reminders set is_archived = true where id = $1 returning id`,
    [id],
  );
  return row !== null;
}

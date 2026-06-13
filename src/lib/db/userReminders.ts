import 'server-only';
import { query, queryOne } from '@/lib/db';
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
  id, title, remind_at::text as remind_at, status,
  entity_type, entity_id, assigned_to, created_by,
  completed_at::text as completed_at, is_archived,
  created_at::text as created_at, updated_at::text as updated_at
`;

// Columns a create/update may set (created_by handled explicitly on create;
// completed_at is derived from status server-side, never client-writable).
const WRITABLE_COLUMNS: (keyof UserReminderWritableFields)[] = [
  'title',
  'remind_at',
  'status',
  'entity_type',
  'entity_id',
  'assigned_to',
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
  const r = await query<UserReminderWithNames>(
    `select ${prefixed('r')},
            ua.full_name as assigned_to_name,
            uc.full_name as created_by_name
       from public.user_reminders r
       left join public.users ua on ua.id = r.assigned_to
       left join public.users uc on uc.id = r.created_by
       ${whereSql}
       order by r.remind_at asc`,
    vals,
  );
  return r.rows;
}

export async function getUserReminderById(id: string): Promise<UserReminderWithNames | null> {
  return queryOne<UserReminderWithNames>(
    `select ${prefixed('r')},
            ua.full_name as assigned_to_name,
            uc.full_name as created_by_name
       from public.user_reminders r
       left join public.users ua on ua.id = r.assigned_to
       left join public.users uc on uc.id = r.created_by
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

import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import type { PoolClient } from 'pg';
import type {
  Task,
  TaskComment,
  TaskKpis,
  TaskListFilters,
  TaskWithAssignee,
  TaskWritableFields,
} from '@/lib/types/tasks';

// Date/timestamp columns are cast to text so they cross the RSC boundary as
// strings (matching the declared `string` types) — pg otherwise returns `date`
// and `timestamptz` as JS Date objects, which crash when rendered in JSX.
const TASK_COLUMNS = `
  id, title, description, status, priority,
  due_date::text as due_date, due_time::text as due_time,
  assigned_to_user_id, debtor_id, apartment_number,
  related_entity_type, related_entity_id, sort_order, is_archived,
  completed_at::text as completed_at,
  created_by, created_by_name,
  created_at::text as created_at, updated_at::text as updated_at
`;

// Columns a create/update may set (title + created_by handled explicitly on
// create; completed_at is derived from status server-side, never client-writable).
const WRITABLE_COLUMNS: (keyof TaskWritableFields)[] = [
  'title',
  'description',
  'status',
  'priority',
  'due_date',
  'due_time',
  'assigned_to_user_id',
  'debtor_id',
  'apartment_number',
  'related_entity_type',
  'related_entity_id',
];

// ── List ──────────────────────────────────────────────────────────────────
export async function listTasks(filters: TaskListFilters): Promise<TaskWithAssignee[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (!filters.includeArchived) {
    where.push('t.is_archived = false');
  }
  if (filters.status) {
    vals.push(filters.status);
    where.push(`t.status = $${vals.length}`);
  }
  if (filters.priority) {
    vals.push(filters.priority);
    where.push(`t.priority = $${vals.length}`);
  }
  if (filters.assignedTo) {
    vals.push(filters.assignedTo);
    where.push(`t.assigned_to_user_id = $${vals.length}`);
  }
  if (filters.relatedEntityType) {
    vals.push(filters.relatedEntityType);
    where.push(`t.related_entity_type = $${vals.length}`);
  }
  if (filters.relatedEntityId) {
    vals.push(filters.relatedEntityId);
    where.push(`t.related_entity_id = $${vals.length}`);
  }
  if (filters.search) {
    vals.push(`%${filters.search}%`);
    where.push(`(t.title ilike $${vals.length} or t.description ilike $${vals.length})`);
  }

  let orderBy: string;
  switch (filters.sort) {
    case 'due_asc':
      orderBy = 't.due_date asc nulls last, t.due_time asc nulls last';
      break;
    case 'priority_desc':
      // urgent > high > normal > low
      orderBy = `case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end asc, t.created_at desc`;
      break;
    case 'updated_desc':
      orderBy = 't.updated_at desc';
      break;
    default:
      orderBy = 't.created_at desc';
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<TaskWithAssignee>(
    `select ${TASK_COLUMNS.split(',').map((c) => 't.' + c.trim()).join(', ')},
            u.full_name as assigned_to_name,
            coalesce(cc.cnt, 0)::int as comment_count
       from public.tasks t
       left join public.users u on u.id = t.assigned_to_user_id
       left join (
         select task_id, count(*)::int as cnt
           from public.task_comments
          group by task_id
       ) cc on cc.task_id = t.id
       ${whereSql}
       order by ${orderBy}`,
    vals,
  );
  return r.rows;
}

/**
 * Tasks with a due_date inside [from, to] (inclusive) — for the calendar's
 * read-only task overlay. Excludes archived tasks. from/to are 'YYYY-MM-DD'.
 */
export async function listTasksWithDueDateInRange(
  from: string,
  to: string,
): Promise<{ id: string; title: string; due_date: string; due_time: string | null; priority: string; status: string }[]> {
  const r = await query<{
    id: string;
    title: string;
    due_date: string;
    due_time: string | null;
    priority: string;
    status: string;
  }>(
    `select id, title, due_date::text as due_date, due_time::text as due_time, priority, status
       from public.tasks
      where is_archived = false
        and due_date is not null
        and due_date >= $1 and due_date <= $2
      order by due_date asc, due_time asc nulls first`,
    [from, to],
  );
  return r.rows;
}

export async function getTaskById(id: string): Promise<TaskWithAssignee | null> {
  return queryOne<TaskWithAssignee>(
    `select ${TASK_COLUMNS.split(',').map((c) => 't.' + c.trim()).join(', ')},
            u.full_name as assigned_to_name,
            coalesce(cc.cnt, 0)::int as comment_count
       from public.tasks t
       left join public.users u on u.id = t.assigned_to_user_id
       left join (
         select task_id, count(*)::int as cnt
           from public.task_comments
          group by task_id
       ) cc on cc.task_id = t.id
      where t.id = $1
      limit 1`,
    [id],
  );
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createTask(
  data: Partial<TaskWritableFields> & { title: string },
  createdBy: string | null,
  createdByName: string | null,
): Promise<Task> {
  const rec = data as Record<string, unknown>;
  const cols: string[] = ['created_by', 'created_by_name'];
  const vals: unknown[] = [createdBy, createdByName];

  // sort_order: append to the end of its status column.
  const status = (data.status ?? 'open') as string;
  const nextSort = await queryOne<{ next: number }>(
    `select coalesce(max(sort_order), -1) + 1 as next from public.tasks where status = $1`,
    [status],
  );

  for (const c of WRITABLE_COLUMNS) {
    if (c in rec && rec[c] !== undefined) {
      cols.push(c);
      vals.push(rec[c]);
    }
  }
  cols.push('sort_order');
  vals.push(nextSort?.next ?? 0);

  // completed_at: stamp it when a task is created already in 'done' (edge case;
  // tasks default to 'open'). Mirrors the status→done logic in updateTask.
  if (status === 'done') {
    cols.push('completed_at');
    vals.push(new Date().toISOString());
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const row = await queryOne<Task>(
    `insert into public.tasks (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${TASK_COLUMNS}`,
    vals,
  );
  if (!row) throw new Error('failed_to_create_task');
  return row;
}

// ── Update ──────────────────────────────────────────────────────────────────
export async function updateTask(
  id: string,
  data: Partial<TaskWritableFields> & { is_archived?: boolean },
): Promise<Task | null> {
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

  // completed_at follows status. Bare `status` / `completed_at` in these SET
  // expressions reference the OLD row values (Postgres UPDATE semantics):
  //  • entering 'done'  → stamp now(), but keep an existing time if it was
  //    already done (so re-saving a done task doesn't reset completion).
  //  • leaving  'done'  → clear to null (reopened / cancelled).
  if ('status' in rec && rec.status !== undefined) {
    set.push(
      rec.status === 'done'
        ? `completed_at = case when status is distinct from 'done' then now() else completed_at end`
        : `completed_at = null`,
    );
  }

  if (set.length === 0) {
    const t = await getTaskById(id);
    return t as Task | null;
  }
  return queryOne<Task>(
    `update public.tasks set ${set.join(', ')} where id = $1 returning ${TASK_COLUMNS}`,
    vals,
  );
}

/**
 * Soft-delete: archive the task (is_archived = true) — the project's
 * soft-delete convention (like debtors). Tasks are never hard-deleted, so the
 * row, its comments and history are retained. Idempotent: re-deleting an
 * already-archived task still returns true. Returns false only when the id
 * doesn't exist.
 */
export async function deleteTask(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update public.tasks set is_archived = true where id = $1 returning id`,
    [id],
  );
  return row !== null;
}

/** Read just the assignee of a task (for assignment-change detection). */
export async function getTaskAssignee(id: string): Promise<string | null | undefined> {
  const row = await queryOne<{ assigned_to_user_id: string | null }>(
    `select assigned_to_user_id from public.tasks where id = $1`,
    [id],
  );
  return row === null ? undefined : row.assigned_to_user_id;
}

// ── Kanban batch reorder ─────────────────────────────────────────────────────
export interface ReorderItem {
  id: string;
  status: string;
  sort_order: number;
}

/** Apply a batch of {id, status, sort_order} updates atomically. */
export async function reorderTasks(items: ReorderItem[]): Promise<void> {
  if (items.length === 0) return;
  await withTransaction(async (client: PoolClient) => {
    for (const it of items) {
      // completed_at tracks the status change here too, so dragging a card
      // into / out of the "done" column behaves like editing its status.
      await client.query(
        `update public.tasks
            set status = $2,
                sort_order = $3,
                completed_at = case
                  when $2 = 'done' and status is distinct from 'done' then now()
                  when $2 <> 'done' then null
                  else completed_at
                end
          where id = $1`,
        [it.id, it.status, it.sort_order],
      );
    }
  });
}

// ── Comments ─────────────────────────────────────────────────────────────────
export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  const r = await query<TaskComment>(
    `select id, task_id, content, author_id, author_name, created_at, updated_at
       from public.task_comments
      where task_id = $1
      order by created_at asc`,
    [taskId],
  );
  return r.rows;
}

export async function createTaskComment(
  taskId: string,
  content: string,
  authorId: string | null,
  authorName: string | null,
): Promise<TaskComment> {
  const row = await queryOne<TaskComment>(
    `insert into public.task_comments (task_id, content, author_id, author_name)
     values ($1, $2, $3, $4)
     returning id, task_id, content, author_id, author_name, created_at, updated_at`,
    [taskId, content, authorId, authorName],
  );
  if (!row) throw new Error('failed_to_create_comment');
  return row;
}

// ── KPIs ──────────────────────────────────────────────────────────────────
export async function getTaskKpis(): Promise<TaskKpis> {
  const row = await queryOne<{ open: number; overdue: number; done_this_month: number }>(
    `select
        count(*) filter (where status in ('open','in_progress') and is_archived = false)::int as open,
        count(*) filter (
          where status in ('open','in_progress')
            and is_archived = false
            and due_date is not null
            and due_date < current_date
        )::int as overdue,
        count(*) filter (
          where status = 'done'
            and updated_at >= date_trunc('month', now())
        )::int as done_this_month
       from public.tasks`,
  );
  return {
    open: row?.open ?? 0,
    overdue: row?.overdue ?? 0,
    doneThisMonth: row?.done_this_month ?? 0,
  };
}

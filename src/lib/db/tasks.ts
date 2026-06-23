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
import type { AssigneeInput } from '@/lib/types/assignee';
import {
  assigneesJsonExpr,
  assigneeExistsSql,
  replaceEntityAssignees,
  listEntityUserIds,
} from '@/lib/db/entityAssignees';
import { targetLabelSql } from '@/lib/db/targets';
import {
  computeOccurrences, parseDateOnly, formatDateOnly,
  type RecurrenceRule, type RecurrenceFrequency,
} from '@/lib/recurrence/engine';

// Date/timestamp columns are cast to text so they cross the RSC boundary as
// strings (matching the declared `string` types) — pg otherwise returns `date`
// and `timestamptz` as JS Date objects, which crash when rendered in JSX.
// Handlers live in entity_assignees (migration 047) — the legacy
// assigned_to_user_id / supplier_id columns are frozen and no longer projected.
const TASK_COLUMNS = `
  id, title, description, status, priority,
  due_date::text as due_date, due_time::text as due_time,
  debtor_id, apartment_number,
  related_entity_type, related_entity_id, target_type, target_id, sort_order, is_archived,
  completed_at::text as completed_at,
  recurrence_id, is_recurring_template, is_recurring_instance, parent_task_id,
  occurrence_date::text as occurrence_date,
  created_by, created_by_name,
  created_at::text as created_at, updated_at::text as updated_at
`;

// Columns a create/update may set (title + created_by handled explicitly on
// create; completed_at is derived from status server-side, never client-writable;
// assignees are written separately to the junction).
const WRITABLE_COLUMNS: (keyof TaskWritableFields)[] = [
  'title',
  'description',
  'status',
  'priority',
  'due_date',
  'due_time',
  'debtor_id',
  'related_entity_type',
  'related_entity_id',
  'target_type',
  'target_id',
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
    where.push(assigneeExistsSql('task', 't', 'user', vals.length));
  }
  if (filters.supplier_id) {
    vals.push(filters.supplier_id);
    where.push(assigneeExistsSql('task', 't', 'supplier', vals.length));
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
            ${assigneesJsonExpr('task', 't')},
            ${targetLabelSql('t')},
            coalesce(cc.cnt, 0)::int as comment_count
       from public.tasks t
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
): Promise<{ id: string; title: string; due_date: string; due_time: string | null; priority: string; status: string; recurring: boolean }[]> {
  const r = await query<{
    id: string;
    title: string;
    due_date: string;
    due_time: string | null;
    priority: string;
    status: string;
    recurring: boolean;
  }>(
    // recurring = the row is linked to a series (template or instance) — drives the
    // recurrence glyph on the calendar chip. A detached occurrence (recurrence_id
    // cleared) is no longer recurring, so the flag follows recurrence_id.
    `select id, title, due_date::text as due_date, due_time::text as due_time, priority, status,
            (recurrence_id is not null) as recurring
       from public.tasks
      where is_archived = false
        and due_date is not null
        and due_date >= $1 and due_date <= $2
      order by due_date asc, due_time asc nulls first`,
    [from, to],
  );
  return r.rows;
}

/** A recurring series (its TEMPLATE task) + the next future occurrence — for the
 *  "מחזוריות" tab. Active, non-archived templates only. */
export interface RecurringSeries {
  id: string; // the template task id (click → open the task)
  title: string;
  frequency: RecurrenceFrequency;
  interval: number;
  byweekday: number[] | null;
  due_time: string | null; // 'HH:MM'
  next_occurrence: string | null; // 'YYYY-MM-DD' — first occurrence >= today, null if none left
}

/** How far ahead to look for a series' next occurrence (covers monthly/yearly
 *  gaps beyond the 45-day materialization horizon). */
const SERIES_LOOKAHEAD_DAYS = 400;

export async function listRecurringSeries(): Promise<RecurringSeries[]> {
  const r = await query<{
    id: string; title: string; due_time: string | null; anchor: string | null;
    recurrence_id: string;
    frequency: RecurrenceFrequency; interval: number; byweekday: number[] | null;
    end_type: RecurrenceRule['endType']; end_date: string | null; end_count: number | null;
  }>(
    `select t.id, t.title, t.due_time::text as due_time,
            coalesce(t.occurrence_date, t.due_date)::text as anchor,
            t.recurrence_id,
            r.frequency, r.interval, r.byweekday,
            r.end_type, r.end_date::text as end_date, r.end_count
       from public.tasks t
       join public.task_recurrences r on r.id = t.recurrence_id
      where t.is_recurring_template = true
        and t.is_archived = false
        and r.is_active = true`,
  );
  if (r.rows.length === 0) return [];

  // Exceptions per recurrence (one query) → skipped dates don't count as "next".
  const recIds = r.rows.map((x) => x.recurrence_id);
  const excRows = await query<{ recurrence_id: string; excluded_date: string }>(
    `select recurrence_id, excluded_date::text as excluded_date
       from public.task_recurrence_exceptions
      where recurrence_id = any($1::uuid[])`,
    [recIds],
  );
  const excByRec = new Map<string, Set<string>>();
  for (const e of excRows.rows) {
    const set = excByRec.get(e.recurrence_id) ?? new Set<string>();
    set.add(e.excluded_date);
    excByRec.set(e.recurrence_id, set);
  }

  // "Today" in Asia/Jerusalem (the app's date convention) + the lookahead window.
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const today = parseDateOnly(todayStr);
  const horizon = today ? new Date(today.getTime()) : null;
  if (horizon) horizon.setUTCDate(horizon.getUTCDate() + SERIES_LOOKAHEAD_DAYS);

  const out: RecurringSeries[] = r.rows.map((row) => {
    let next: string | null = null;
    const anchor = row.anchor ? parseDateOnly(row.anchor) : null;
    if (anchor && horizon && today) {
      const rule: RecurrenceRule = {
        frequency: row.frequency, interval: row.interval, byweekday: row.byweekday,
        endType: row.end_type, endDate: row.end_date, endCount: row.end_count,
      };
      const occ = computeOccurrences(rule, anchor, horizon, excByRec.get(row.recurrence_id) ?? new Set())
        .map(formatDateOnly);
      next = occ.find((d) => d >= todayStr) ?? null;
    }
    return {
      id: row.id,
      title: row.title,
      frequency: row.frequency,
      interval: row.interval,
      byweekday: row.byweekday,
      due_time: row.due_time ? row.due_time.slice(0, 5) : null,
      next_occurrence: next,
    };
  });

  // Sort by next occurrence ascending; series with no upcoming occurrence last.
  out.sort((a, b) => {
    if (a.next_occurrence === b.next_occurrence) return a.title.localeCompare(b.title, 'he');
    if (a.next_occurrence === null) return 1;
    if (b.next_occurrence === null) return -1;
    return a.next_occurrence < b.next_occurrence ? -1 : 1;
  });
  return out;
}

/**
 * Open / in-progress (not completed), non-archived tasks whose due_date falls in
 * [from, to] — the scheduled task_due_soon scan (cron). from/to are 'YYYY-MM-DD'
 * computed in Asia/Jerusalem. Returns the set of user assignees so the cron can
 * target them (empty → the cron fans out to active admins instead).
 */
export async function listTasksDueSoon(
  from: string,
  to: string,
): Promise<{
  id: string;
  title: string;
  due_date: string;
  due_time: string | null;
  priority: string;
  assigned_user_ids: string[];
}[]> {
  const r = await query<{
    id: string;
    title: string;
    due_date: string;
    due_time: string | null;
    priority: string;
    assigned_user_ids: string[];
  }>(
    `select t.id, t.title, t.due_date::text as due_date, t.due_time::text as due_time,
            t.priority,
            coalesce((
              select array_agg(ea.user_id)
                from public.entity_assignees ea
               where ea.entity_type = 'task' and ea.entity_id = t.id and ea.user_id is not null
            ), '{}') as assigned_user_ids
       from public.tasks t
      where t.is_archived = false
        and t.status in ('open', 'in_progress')
        and t.due_date is not null
        and t.due_date >= $1 and t.due_date <= $2
      order by t.due_date asc, t.due_time asc nulls first`,
    [from, to],
  );
  return r.rows;
}

export async function getTaskById(id: string): Promise<TaskWithAssignee | null> {
  return queryOne<TaskWithAssignee>(
    `select ${TASK_COLUMNS.split(',').map((c) => 't.' + c.trim()).join(', ')},
            ${assigneesJsonExpr('task', 't')},
            ${targetLabelSql('t')},
            coalesce(cc.cnt, 0)::int as comment_count
       from public.tasks t
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
  assignees: AssigneeInput[],
  createdBy: string | null,
  createdByName: string | null,
): Promise<TaskWithAssignee> {
  const rec = data as Record<string, unknown>;
  const status = (data.status ?? 'open') as string;

  // Task row + junction rows commit atomically (the assignee no longer rides on
  // the task INSERT).
  const id = await withTransaction(async (client: PoolClient) => {
    const cols: string[] = ['created_by', 'created_by_name'];
    const vals: unknown[] = [createdBy, createdByName];

    const nextSort = await client.query<{ next: number }>(
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
    vals.push(nextSort.rows[0]?.next ?? 0);

    // completed_at: stamp when created already in 'done' (edge case; default 'open').
    if (status === 'done') {
      cols.push('completed_at');
      vals.push(new Date().toISOString());
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const row = await client.query<{ id: string }>(
      `insert into public.tasks (${cols.join(', ')})
       values (${placeholders.join(', ')})
       returning id`,
      vals,
    );
    const newId = row.rows[0]?.id;
    if (!newId) throw new Error('failed_to_create_task');
    await replaceEntityAssignees(client, 'task', newId, assignees, createdBy);
    return newId;
  });

  const task = await getTaskById(id);
  if (!task) throw new Error('failed_to_create_task');
  return task;
}

// ── Update ──────────────────────────────────────────────────────────────────
// `assignees === undefined` → leave the junction untouched (partial PATCH);
// an array (possibly empty) → replace the full assignee set.
export async function updateTask(
  id: string,
  data: Partial<TaskWritableFields> & { is_archived?: boolean },
  assignees?: AssigneeInput[],
  actorId?: string | null,
): Promise<TaskWithAssignee | null> {
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

  // completed_at follows status (bare `status`/`completed_at` reference the OLD
  // row values per Postgres UPDATE semantics).
  if ('status' in rec && rec.status !== undefined) {
    set.push(
      rec.status === 'done'
        ? `completed_at = case when status is distinct from 'done' then now() else completed_at end`
        : `completed_at = null`,
    );
  }

  const existed = await withTransaction(async (client: PoolClient) => {
    let exists: boolean;
    if (set.length > 0) {
      const r = await client.query<{ id: string }>(
        `update public.tasks set ${set.join(', ')} where id = $1 returning id`,
        vals,
      );
      exists = (r.rowCount ?? 0) > 0;
    } else {
      const r = await client.query<{ id: string }>(
        `select id from public.tasks where id = $1`,
        [id],
      );
      exists = (r.rowCount ?? 0) > 0;
    }
    if (exists && assignees !== undefined) {
      await replaceEntityAssignees(client, 'task', id, assignees, actorId ?? null);
    }
    return exists;
  });

  if (!existed) return null;
  return getTaskById(id);
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

/** The set of user-kind assignee ids of a task, or null if the task does not
 *  exist — used by PATCH to compute newly-added assignees (set-diff) and to 404. */
export async function getTaskUserAssignees(id: string): Promise<string[] | null> {
  const exists = await queryOne<{ id: string }>(`select id from public.tasks where id = $1`, [id]);
  if (!exists) return null;
  return listEntityUserIds('task', id);
}

// ── Kanban batch reorder ─────────────────────────────────────────────────────
export interface ReorderItem {
  id: string;
  priority: string;
  sort_order: number;
}

/** Apply a batch of {id, priority, sort_order} updates atomically. The board's
 *  primary axis is priority — dragging between lanes re-prioritises and reorders.
 *  Completing ("בוצע") is a separate status change via the [id] PATCH route
 *  (which stamps completed_at and clears reminders), never here. */
export async function reorderTasks(items: ReorderItem[]): Promise<void> {
  if (items.length === 0) return;
  await withTransaction(async (client: PoolClient) => {
    for (const it of items) {
      await client.query(
        `update public.tasks set priority = $2, sort_order = $3 where id = $1`,
        [it.id, it.priority, it.sort_order],
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

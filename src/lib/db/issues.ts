import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import type { PoolClient } from 'pg';
import type {
  Issue,
  IssueComment,
  IssueKpis,
  IssueListFilters,
  IssueStatus,
  IssueWithMeta,
  IssueWritableFields,
} from '@/lib/types/issues';
import type { AssigneeInput } from '@/lib/types/assignee';
import {
  assigneesJsonExpr,
  assigneeExistsSql,
  replaceEntityAssignees,
  copyEntityAssignees,
  listEntityUserIds,
} from '@/lib/db/entityAssignees';
import { targetLabelSql } from '@/lib/db/targets';

// Handlers live in entity_assignees (migration 047) — the legacy
// assigned_to_user_id / supplier_id columns are frozen and no longer projected.
const ISSUE_COLUMNS = `
  id, title, description, location_type, location_text, target_type, target_id, priority, status,
  due_date::text as due_date, due_time::text as due_time,
  images, resolution_notes, resolved_at::text as resolved_at, is_archived, sort_order,
  created_by, created_by_name, created_at::text as created_at, updated_at::text as updated_at
`;

// Columns a create/update may set (title + created_by handled explicitly on
// create; assignees are written separately to the junction).
const WRITABLE_COLUMNS: (keyof IssueWritableFields)[] = [
  'title',
  'description',
  // location_type / location_text are deprecated (Base44 remnants) — kept as DB
  // columns + read in ISSUE_COLUMNS, but no longer written from the form.
  'target_type',
  'target_id',
  'priority',
  'status',
  'resolution_notes',
  'due_date',
  'due_time',
];

const META_SELECT = `
  ${ISSUE_COLUMNS.split(',').map((c) => 'i.' + c.trim()).join(', ')},
  ${assigneesJsonExpr('issue', 'i')},
  ${targetLabelSql('i')},
  coalesce(cc.cnt, 0)::int as comment_count,
  lt.id as linked_task_id
`;

const META_JOINS = `
  from public.issues i
  left join (
    select issue_id, count(*)::int as cnt
      from public.issue_comments
     group by issue_id
  ) cc on cc.issue_id = i.id
  left join lateral (
    select t.id from public.tasks t
     where t.issue_id = i.id
     order by t.created_at asc
     limit 1
  ) lt on true
`;

// ── List ──────────────────────────────────────────────────────────────────
export async function listIssues(filters: IssueListFilters): Promise<IssueWithMeta[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (!filters.includeArchived) {
    where.push('i.is_archived = false');
  }
  if (filters.status) {
    vals.push(filters.status);
    where.push(`i.status = $${vals.length}`);
  }
  if (filters.priority) {
    vals.push(filters.priority);
    where.push(`i.priority = $${vals.length}`);
  }
  if (filters.assignedTo) {
    vals.push(filters.assignedTo);
    where.push(assigneeExistsSql('issue', 'i', 'user', vals.length));
  }
  if (filters.supplier_id) {
    vals.push(filters.supplier_id);
    where.push(assigneeExistsSql('issue', 'i', 'supplier', vals.length));
  }
  if (filters.search) {
    vals.push(`%${filters.search}%`);
    where.push(
      `(i.title ilike $${vals.length} or i.description ilike $${vals.length} or i.location_text ilike $${vals.length})`,
    );
  }

  let orderBy: string;
  switch (filters.sort) {
    case 'priority_desc':
      orderBy = `case i.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end asc, i.created_at desc`;
      break;
    case 'updated_desc':
      orderBy = 'i.updated_at desc';
      break;
    case 'status_asc':
      orderBy = `case i.status when 'open' then 0 when 'in_progress' then 1 when 'resolved' then 2 else 3 end asc, i.created_at desc`;
      break;
    default:
      orderBy = 'i.created_at desc';
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<IssueWithMeta>(
    `select ${META_SELECT} ${META_JOINS} ${whereSql} order by ${orderBy}`,
    vals,
  );
  return r.rows;
}

/**
 * Active issues with a due_date inside [from, to] (inclusive) — for the
 * calendar's read-only issue overlay. Only open / in_progress issues surface on
 * the calendar (resolved & closed are hidden); archived are always excluded.
 * from/to are 'YYYY-MM-DD'. Mirrors listTasksWithDueDateInRange.
 */
export async function listIssuesWithDueDateInRange(
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
       from public.issues
      where is_archived = false
        and status in ('open', 'in_progress')
        and due_date is not null
        and due_date >= $1 and due_date <= $2
      order by due_date asc, due_time asc nulls first`,
    [from, to],
  );
  return r.rows;
}

export async function getIssueById(id: string): Promise<IssueWithMeta | null> {
  return queryOne<IssueWithMeta>(
    `select ${META_SELECT} ${META_JOINS} where i.id = $1 limit 1`,
    [id],
  );
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createIssue(
  data: Partial<IssueWritableFields> & { title: string },
  assignees: AssigneeInput[],
  createdBy: string | null,
  createdByName: string | null,
): Promise<IssueWithMeta> {
  const rec = data as Record<string, unknown>;

  const id = await withTransaction(async (client: PoolClient) => {
    const cols: string[] = ['created_by', 'created_by_name'];
    const vals: unknown[] = [createdBy, createdByName];

    for (const c of WRITABLE_COLUMNS) {
      if (c in rec && rec[c] !== undefined) {
        cols.push(c);
        vals.push(rec[c]);
      }
    }

    // resolved_at follows status on create.
    if (data.status === 'resolved') {
      cols.push('resolved_at');
      vals.push(new Date().toISOString());
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const row = await client.query<{ id: string }>(
      `insert into public.issues (${cols.join(', ')})
       values (${placeholders.join(', ')})
       returning id`,
      vals,
    );
    const newId = row.rows[0]?.id;
    if (!newId) throw new Error('failed_to_create_issue');
    await replaceEntityAssignees(client, 'issue', newId, assignees, createdBy);
    return newId;
  });

  const issue = await getIssueById(id);
  if (!issue) throw new Error('failed_to_create_issue');
  return issue;
}

// ── Update ──────────────────────────────────────────────────────────────────
// `assignees === undefined` → leave the junction untouched (partial PATCH);
// an array (possibly empty) → replace the full assignee set.
export async function updateIssue(
  id: string,
  data: Partial<IssueWritableFields> & { is_archived?: boolean },
  assignees?: AssigneeInput[],
  actorId?: string | null,
): Promise<IssueWithMeta | null> {
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

  // resolved_at transitions: set when entering 'resolved', clear when leaving it.
  if (data.status !== undefined) {
    if (data.status === 'resolved') {
      set.push(`resolved_at = coalesce(resolved_at, now())`);
    } else {
      set.push(`resolved_at = null`);
    }
  }

  const existed = await withTransaction(async (client: PoolClient) => {
    let exists: boolean;
    if (set.length > 0) {
      const r = await client.query<{ id: string }>(
        `update public.issues set ${set.join(', ')} where id = $1 returning id`,
        vals,
      );
      exists = (r.rowCount ?? 0) > 0;
    } else {
      const r = await client.query<{ id: string }>(
        `select id from public.issues where id = $1`,
        [id],
      );
      exists = (r.rowCount ?? 0) > 0;
    }
    if (exists && assignees !== undefined) {
      await replaceEntityAssignees(client, 'issue', id, assignees, actorId ?? null);
    }
    return exists;
  });

  if (!existed) return null;
  return getIssueById(id);
}

export async function deleteIssue(id: string): Promise<boolean> {
  // entity_id is polymorphic (no FK), so the junction rows don't cascade — clean
  // them up atomically with the hard delete.
  return withTransaction(async (client: PoolClient) => {
    await client.query(
      `delete from public.entity_assignees where entity_type = 'issue' and entity_id = $1`,
      [id],
    );
    const r = await client.query(`delete from public.issues where id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

// ── Kanban batch reorder (migration 050) ─────────────────────────────────────
export interface IssueReorderItem {
  id: string;
  priority: string;
  sort_order: number;
}

/** Apply a batch of {id, priority, sort_order} updates to issues atomically. The
 *  board's primary axis is priority — dragging between lanes re-prioritises and
 *  reorders. Resolving ("בוצע") is a separate status change via the [id] PATCH
 *  route (which stamps resolved_at and clears reminders), never here. */
export async function reorderIssues(items: IssueReorderItem[]): Promise<void> {
  if (items.length === 0) return;
  await withTransaction(async (client: PoolClient) => {
    for (const it of items) {
      await client.query(
        `update public.issues set priority = $2, sort_order = $3 where id = $1`,
        [it.id, it.priority, it.sort_order],
      );
    }
  });
}

/** The set of user-kind assignee ids + status of an issue, or null if it does
 *  not exist — used by PATCH for assignment-change set-diff + status-change notify. */
export async function getIssueAssigneeStatus(
  id: string,
): Promise<{ assignedUserIds: string[]; status: IssueStatus } | null> {
  const row = await queryOne<{ status: IssueStatus }>(
    `select status from public.issues where id = $1`,
    [id],
  );
  if (!row) return null;
  const assignedUserIds = await listEntityUserIds('issue', id);
  return { assignedUserIds, status: row.status };
}

// ── Images ───────────────────────────────────────────────────────────────────
/** Read just the images array of an issue. */
export async function getIssueImages(id: string): Promise<string[] | null> {
  const row = await queryOne<{ images: string[] }>(
    `select images from public.issues where id = $1`,
    [id],
  );
  return row ? row.images : null;
}

/** Overwrite the images array (used after remove). Returns the saved value. */
export async function setIssueImages(id: string, images: string[]): Promise<string[] | null> {
  const row = await queryOne<{ images: string[] }>(
    `update public.issues set images = $2 where id = $1 returning images`,
    [id, images],
  );
  return row ? row.images : null;
}

export type AppendImageResult =
  | { status: 'appended'; images: string[] }
  | { status: 'full' }
  | { status: 'not_found' };

/**
 * Atomically append a path to issues.images, enforcing the max-count cap inside
 * a single SQL statement (no read-modify-write race). The append only happens
 * when the array is still under `maxImages`; otherwise the row is unchanged and
 * we report 'full'. Caller cleans up the orphaned object on 'full'/'not_found'.
 */
export async function appendIssueImage(
  id: string,
  path: string,
  maxImages: number,
): Promise<AppendImageResult> {
  const row = await queryOne<{ images: string[]; appended: boolean }>(
    `update public.issues
        set images = array_append(images, $2)
      where id = $1
        and coalesce(array_length(images, 1), 0) < $3
      returning images, true as appended`,
    [id, path, maxImages],
  );
  if (row) return { status: 'appended', images: row.images };

  // No row updated: either the issue doesn't exist or it's at capacity.
  const exists = await queryOne<{ id: string }>(
    `select id from public.issues where id = $1`,
    [id],
  );
  return exists ? { status: 'full' } : { status: 'not_found' };
}

// ── Comments ─────────────────────────────────────────────────────────────────
export async function listIssueComments(issueId: string): Promise<IssueComment[]> {
  const r = await query<IssueComment>(
    `select id, issue_id, content, author_id, author_name, created_at, updated_at
       from public.issue_comments
      where issue_id = $1
      order by created_at asc`,
    [issueId],
  );
  return r.rows;
}

export async function createIssueComment(
  issueId: string,
  content: string,
  authorId: string | null,
  authorName: string | null,
): Promise<IssueComment> {
  const row = await queryOne<IssueComment>(
    `insert into public.issue_comments (issue_id, content, author_id, author_name)
     values ($1, $2, $3, $4)
     returning id, issue_id, content, author_id, author_name, created_at, updated_at`,
    [issueId, content, authorId, authorName],
  );
  if (!row) throw new Error('failed_to_create_comment');
  return row;
}

// ── KPIs ──────────────────────────────────────────────────────────────────
// `scopeUserId` scopes the counts to issues that user is assigned to (field-
// worker isolation — see lib/auth/issueAccess). null/undefined → all issues.
export async function getIssueKpis(scopeUserId?: string | null): Promise<IssueKpis> {
  const scopeClause = scopeUserId
    ? `where exists (select 1 from public.entity_assignees ea
          where ea.entity_type = 'issue' and ea.entity_id = i.id and ea.user_id = $1)`
    : '';
  const vals = scopeUserId ? [scopeUserId] : [];
  const row = await queryOne<{ open: number; urgent: number; resolved_this_month: number }>(
    `select
        count(*) filter (where status in ('open','in_progress') and is_archived = false)::int as open,
        count(*) filter (
          where status in ('open','in_progress')
            and is_archived = false
            and priority = 'urgent'
        )::int as urgent,
        count(*) filter (
          where status = 'resolved'
            and resolved_at >= date_trunc('month', now())
        )::int as resolved_this_month
       from public.issues i
       ${scopeClause}`,
    vals,
  );
  return {
    open: row?.open ?? 0,
    urgent: row?.urgent ?? 0,
    resolvedThisMonth: row?.resolved_this_month ?? 0,
  };
}

// ── Create-task-from-issue (transactional) ────────────────────────────────────
export interface CreatedTaskFromIssue {
  id: string;
  title: string;
  priority: string;
  due_date: string | null;
  /** User-kind assignees copied onto the task — for the assignment notification. */
  assigned_user_ids: string[];
}

/**
 * Create a task linked to an issue, in a single transaction. Copies title,
 * description, priority and the FULL assignee set (users + suppliers) from the
 * issue's junction into the task's junction, and sets tasks.issue_id. Returns
 * the new task (or null if a task is already linked to this issue).
 */
export async function createTaskFromIssue(
  issue: Issue,
  createdBy: string | null,
  createdByName: string | null,
): Promise<CreatedTaskFromIssue | null> {
  return withTransaction(async (client: PoolClient) => {
    // Guard against double-linking: one task per issue.
    const existing = await client.query<{ id: string }>(
      `select id from public.tasks where issue_id = $1 limit 1`,
      [issue.id],
    );
    if (existing.rows[0]) return null;

    const status = 'open';
    const next = await client.query<{ next: number }>(
      `select coalesce(max(sort_order), -1) + 1 as next from public.tasks where status = $1`,
      [status],
    );
    const sortOrder = next.rows[0]?.next ?? 0;

    const r = await client.query<{ id: string; title: string; priority: string; due_date: string | null }>(
      `insert into public.tasks
         (title, description, priority, status, issue_id,
          sort_order, created_by, created_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, title, priority, due_date::text as due_date`,
      [
        issue.title,
        issue.description,
        issue.priority,
        status,
        issue.id,
        sortOrder,
        createdBy,
        createdByName,
      ],
    );
    const task = r.rows[0];
    if (!task) return null;

    // Copy the issue's full handler set (users + suppliers) onto the task.
    await copyEntityAssignees(client, 'issue', issue.id, 'task', task.id, createdBy);

    const users = await client.query<{ user_id: string }>(
      `select user_id from public.entity_assignees
        where entity_type = 'task' and entity_id = $1 and user_id is not null`,
      [task.id],
    );
    return { ...task, assigned_user_ids: users.rows.map((u) => u.user_id) };
  });
}

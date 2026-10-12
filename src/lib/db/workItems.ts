import 'server-only';
import { query, withTransaction } from '@/lib/db';
import type { PoolClient } from 'pg';
import { assigneesJsonExpr, assigneeExistsSql } from '@/lib/db/entityAssignees';
import type { WorkItem, WorkItemKind, WorkItemKpis, WorkItemListFilters } from '@/lib/types/workItems';
import { workItemScopeSql, type WorkItemScopeActor } from '@/lib/auth/workItemAccess';

/**
 * Per-kind read feed for the תקלות (issues) and משימות (tasks) screens
 * (12/10/2026 — replaces the 11/10/2026 combined `issues UNION ALL tasks`
 * CTE: the two screens now share only this query SHAPE and the scope/column
 * logic, never a query that touches both tables at once — "אפס ערבוב
 * נתונים", Decisions Log 12/10/2026). Mutations stay per-kind, as before —
 * this is the list/board/KPI read path only.
 */
const ISSUE_CTE = `
  with scoped as (
    select
      'issue' as kind, i.id, i.title, i.priority, i.status_v2, i.blocked, i.blocked_reason,
      i.due_date::text as due_date,
      i.assignee_user_id, i.assignee_supplier_id,
      coalesce(au.full_name, au.username, asup.display_name) as assignee_display_name,
      i.source, (i.source = 'portal') as is_from_resident,
      i.reporter_apartment as source_apartment, i.reporter_name as source_reporter_name,
      coalesce(cc.cnt, 0)::int as comment_count,
      (coalesce(array_length(i.images, 1), 0) + coalesce(array_length(i.videos, 1), 0))::int as attachment_count,
      false as is_recurring, false as is_recurring_paused,
      i.created_by, i.created_by_name, i.created_at::text as created_at, i.updated_at::text as updated_at,
      i.closed_at::text as closed_at, i.archived_at::text as archived_at, i.sort_index,
      (i.created_at >= now() - interval '24 hours' and i.assignee_user_id is null and i.assignee_supplier_id is null) as is_new,
      ${assigneesJsonExpr('issue', 'i')}
    from public.issues i
    left join public.users au on au.id = i.assignee_user_id
    left join public.suppliers asup on asup.id = i.assignee_supplier_id
    left join (
      select issue_id, count(*)::int as cnt from public.issue_comments group by issue_id
    ) cc on cc.issue_id = i.id
    where i.is_archived = false
  )
`;

const TASK_CTE = `
  with scoped as (
    select
      'task' as kind, t.id, t.title, t.priority, t.status_v2, t.blocked, t.blocked_reason,
      t.due_date::text as due_date,
      t.assignee_user_id, t.assignee_supplier_id,
      coalesce(au.full_name, au.username, asup.display_name) as assignee_display_name,
      t.source, (t.source = 'tenant') as is_from_resident,
      t.source_apartment, t.source_reporter_name,
      coalesce(cc.cnt, 0)::int as comment_count,
      0 as attachment_count,
      (t.recurrence_id is not null) as is_recurring, t.is_recurring_paused,
      t.created_by, t.created_by_name, t.created_at::text as created_at, t.updated_at::text as updated_at,
      t.closed_at::text as closed_at, t.archived_at::text as archived_at, t.sort_index,
      (t.created_at >= now() - interval '24 hours' and t.assignee_user_id is null and t.assignee_supplier_id is null) as is_new,
      ${assigneesJsonExpr('task', 't')}
    from public.tasks t
    left join public.users au on au.id = t.assignee_user_id
    left join public.suppliers asup on asup.id = t.assignee_supplier_id
    left join (
      select task_id, count(*)::int as cnt from public.task_comments group by task_id
    ) cc on cc.task_id = t.id
    where t.is_archived = false
  )
`;

function cteFor(kind: WorkItemKind): string {
  return kind === 'issue' ? ISSUE_CTE : TASK_CTE;
}

interface ScopedRow {
  kind: 'issue' | 'task';
  id: string;
  title: string;
  priority: 'normal' | 'high' | 'urgent';
  status_v2: 'open' | 'in_progress' | 'closed';
  blocked: boolean;
  blocked_reason: string | null;
  due_date: string | null;
  assignee_user_id: string | null;
  assignee_supplier_id: string | null;
  assignee_display_name: string | null;
  source: string;
  is_from_resident: boolean;
  source_apartment: string | null;
  source_reporter_name: string | null;
  comment_count: number;
  attachment_count: number;
  is_recurring: boolean;
  is_recurring_paused: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  archived_at: string | null;
  sort_index: number | null;
  is_new: boolean;
  assignees: { assignee_type: 'user' | 'supplier'; user_id: string | null; supplier_id: string | null; display_name: string | null }[];
}

function toWorkItem(r: ScopedRow): WorkItem {
  return {
    kind: r.kind,
    id: r.id,
    title: r.title,
    priority: r.priority,
    status_v2: r.status_v2,
    blocked: r.blocked,
    blocked_reason: r.blocked_reason,
    due_date: r.due_date,
    assignee:
      r.assignee_user_id !== null
        ? { kind: 'user', id: r.assignee_user_id, display_name: r.assignee_display_name ?? '—' }
        : r.assignee_supplier_id !== null
          ? { kind: 'supplier', id: r.assignee_supplier_id, display_name: r.assignee_display_name ?? '—' }
          : null,
    source: r.source,
    is_from_resident: r.is_from_resident,
    source_apartment: r.source_apartment,
    source_reporter_name: r.source_reporter_name,
    comment_count: r.comment_count,
    attachment_count: r.attachment_count,
    is_recurring: r.is_recurring,
    is_recurring_paused: r.is_recurring_paused,
    created_by: r.created_by,
    created_by_name: r.created_by_name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
    sort_index: r.sort_index,
    is_new: r.is_new,
    assignees: (r.assignees ?? []).map((a) => ({
      kind: a.assignee_type,
      id: (a.assignee_type === 'user' ? a.user_id : a.supplier_id) ?? '',
      display_name: a.display_name ?? '—',
    })),
  };
}

const PRIORITY_RANK = `case priority when 'urgent' then 0 when 'high' then 1 else 2 end`;
const STATUS_RANK = `case status_v2 when 'closed' then 1 else 0 end`;

export async function listWorkItems(
  kind: WorkItemKind,
  filters: WorkItemListFilters,
  actor: WorkItemScopeActor,
): Promise<WorkItem[]> {
  const where: string[] = [];
  const vals: unknown[] = [];

  if (filters.tab === 'archive') {
    where.push('archived_at is not null');
  } else {
    // 'active' (and 'recurring', though that tab uses listRecurringSeries
    // directly and never calls this). Not-yet-archived; closed items older
    // than 7 days are excluded here — the nightly archive job moves them to
    // the archive tab before that matters in practice, but this keeps the
    // feed correct even if the job is behind.
    // closed_at is text here (cast in the CTE's SELECT, for the RSC boundary)
    // — cast back to compare against now().
    where.push(`archived_at is null and (status_v2 <> 'closed' or closed_at::timestamptz >= now() - interval '7 days')`);
  }

  if (filters.priority) {
    vals.push(filters.priority);
    where.push(`priority = $${vals.length}`);
  }
  if (filters.assigneeUserId === 'unassigned') {
    where.push('assignee_user_id is null and assignee_supplier_id is null');
  } else if (filters.assigneeUserId) {
    // Primary assignee OR a multi-assignee membership — "סינון עובד מחזיר את
    // הכרטיס לכל משויך" (decision 12/10/2026): a card shows once, at its
    // primary lane, but a filter by employee must still surface it for every
    // employee it is assigned to, not only the primary one.
    vals.push(filters.assigneeUserId);
    where.push(`(assignee_user_id = $${vals.length} or ${assigneeExistsSql(kind, 'scoped', 'user', vals.length)})`);
  }
  if (filters.search) {
    vals.push(`%${filters.search}%`);
    where.push(`title ilike $${vals.length}`);
  }

  const scope = workItemScopeSql(actor, 'scoped', vals.length, kind);
  vals.push(...scope.params);
  // workItemScopeSql returns a leading "and" fragment; fold it into the WHERE
  // list as a plain clause (strip the "and " prefix it was written with).
  const scopeClause = scope.sql ? scope.sql.replace(/^\s*and\s*/i, '') : '';
  if (scopeClause) where.push(scopeClause);

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<ScopedRow>(
    `${cteFor(kind)}
     select * from scoped
     ${whereSql}
     order by ${STATUS_RANK} asc, ${PRIORITY_RANK} asc, sort_index asc nulls last,
              due_date asc nulls last, created_at desc`,
    vals,
  );
  return r.rows.map(toWorkItem);
}

export async function getWorkItemKpis(kind: WorkItemKind, actor: WorkItemScopeActor): Promise<WorkItemKpis> {
  const scope = workItemScopeSql(actor, 'scoped', 0, kind);
  const scopeClause = scope.sql ? scope.sql.replace(/^\s*and\s*/i, '') : '';
  const where = [`archived_at is null`, `status_v2 <> 'closed'`, ...(scopeClause ? [scopeClause] : [])].join(' and ');
  const row = await query<{ urgent: number; unassigned: number; due_today: number; overdue: number }>(
    `${cteFor(kind)}
     select
       count(*) filter (where priority = 'urgent')::int as urgent,
       count(*) filter (where assignee_user_id is null and assignee_supplier_id is null)::int as unassigned,
       count(*) filter (where due_date::date = current_date)::int as due_today,
       count(*) filter (where due_date::date < current_date)::int as overdue
     from scoped
     where ${where}`,
    scope.params,
  );
  const k = row.rows[0];
  return {
    urgentActive: k?.urgent ?? 0,
    unassigned: k?.unassigned ?? 0,
    dueToday: k?.due_today ?? 0,
    overdue: k?.overdue ?? 0,
  };
}

// ── Board: within-lane manual reorder ───────────────────────────────────────
// "גרירה ידנית לסדר רק בתוך אותה דרגת דחיפות" (decision 11/10/2026) — dragging
// a card BETWEEN lanes (employee columns) is a reassignment, handled by
// setIssuePrimaryAssignee/setTaskPrimaryAssignee (the same action as the quick-
// assign popover). This function ONLY repositions a card within its current
// lane (same primary assignee) and priority tier, via a numeric fractional
// index — no renumbering of sibling rows, unlike the issues board's integer
// sort_order.
export type ReorderResult = 'moved' | 'not_found' | 'cross_lane';

function midpoint(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 0;
  if (prev === null) return (next as number) - 1;
  if (next === null) return prev + 1;
  return (prev + next) / 2;
}

const TABLE: Record<WorkItemKind, string> = { issue: 'public.issues', task: 'public.tasks' };

export async function reorderWorkItemWithinLane(
  kind: WorkItemKind,
  id: string,
  beforeId: string | null,
): Promise<ReorderResult> {
  const table = TABLE[kind];
  return withTransaction(async (client: PoolClient) => {
    const draggedR = await client.query<{
      assignee_user_id: string | null;
      assignee_supplier_id: string | null;
      priority: string;
    }>(`select assignee_user_id, assignee_supplier_id, priority from ${table} where id = $1 for update`, [id]);
    const dragged = draggedR.rows[0];
    if (!dragged) return 'not_found';

    if (beforeId !== null) {
      const beforeR = await client.query<{
        assignee_user_id: string | null;
        assignee_supplier_id: string | null;
        priority: string;
      }>(`select assignee_user_id, assignee_supplier_id, priority from ${table} where id = $1`, [beforeId]);
      const before = beforeR.rows[0];
      if (!before) return 'not_found';
      if (
        before.assignee_user_id !== dragged.assignee_user_id ||
        before.assignee_supplier_id !== dragged.assignee_supplier_id ||
        before.priority !== dragged.priority
      ) {
        return 'cross_lane';
      }
    }

    // The lane+tier's current order, same shape as the per-kind list query.
    const laneR = await client.query<{ id: string; sort_index: number | null }>(
      `select id, sort_index
         from ${table}
        where id <> $1
          and priority = $2
          and coalesce(assignee_user_id::text, '') = coalesce($3::text, '')
          and coalesce(assignee_supplier_id::text, '') = coalesce($4::text, '')
          and is_archived = false and archived_at is null and status_v2 <> 'closed'
        order by sort_index asc nulls last, due_date asc nulls last, created_at desc`,
      [id, dragged.priority, dragged.assignee_user_id, dragged.assignee_supplier_id],
    );

    const idx = beforeId === null ? laneR.rows.length : laneR.rows.findIndex((r) => r.id === beforeId);
    if (beforeId !== null && idx === -1) return 'not_found';
    const prev = idx > 0 ? laneR.rows[idx - 1].sort_index : null;
    const next = idx < laneR.rows.length ? laneR.rows[idx].sort_index : null;
    const newIndex = midpoint(prev, next);

    await client.query(`update ${table} set sort_index = $2 where id = $1`, [id, newIndex]);
    return 'moved';
  });
}

// ── Archive ──────────────────────────────────────────────────────────────
/** Restore an archived item (clear archived_at) — the archive tab's one
 *  mutation. Does not touch status_v2/closed_at: a restored item reappears in
 *  the active feed still closed, exactly where it was before archiving. */
export async function restoreWorkItem(kind: WorkItemKind, id: string): Promise<boolean> {
  const table = TABLE[kind];
  const r = await query(`update ${table} set archived_at = null where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Nightly archive sweep — closed_at older than 30 days -> archived_at =
 *  now(), on both tables (the two independent UPDATEs below never join or
 *  read across tables, so this stays consistent with "zero data mixing" even
 *  though one cron run does both screens' housekeeping). Never touches
 *  recurring templates (is_recurring_template rows stay in the recurring tab
 *  forever). Returns the count archived per table, for the cron log. */
export async function archiveOldClosedWorkItems(): Promise<{ issues: number; tasks: number }> {
  const issuesR = await query(
    `update public.issues
        set archived_at = now()
      where status_v2 = 'closed' and archived_at is null
        and closed_at is not null and closed_at < now() - interval '30 days'`,
  );
  const tasksR = await query(
    `update public.tasks
        set archived_at = now()
      where status_v2 = 'closed' and archived_at is null
        and closed_at is not null and closed_at < now() - interval '30 days'
        and is_recurring_template = false`,
  );
  return { issues: issuesR.rowCount ?? 0, tasks: tasksR.rowCount ?? 0 };
}

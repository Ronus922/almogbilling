import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import { copyEntityAssignees } from '@/lib/db/entityAssignees';
import {
  computeOccurrences,
  parseDateOnly,
  formatDateOnly,
  HORIZON_DAYS,
  type RecurrenceRule,
} from '@/lib/recurrence/engine';

// Server-side recurrence engine: persists rules, materializes task INSTANCES
// ahead of the horizon, and runs the per-occurrence series actions.
//
// Reminders / assignment-notify are deliberately NOT propagated to materialized
// instances: that would flood the user with one reminder/bell per occurrence.
// Instead each instance is created with its assignees copied, so the existing
// `task_due_soon` cron (lib/db/tasks.listTasksDueSoon) naturally nudges the
// assignees as each instance's due date approaches — covering "the nearest
// upcoming occurrence" without per-instance reminder rows.

/** A recurrence rule + its identity/active flag, as the form/detail API needs it. */
export interface TaskRecurrenceInfo extends RecurrenceRule {
  id: string;
  isActive: boolean;
}

interface RecurrenceRow {
  id: string;
  is_active: boolean;
  frequency: RecurrenceRule['frequency'];
  interval: number;
  byweekday: number[] | null;
  end_type: RecurrenceRule['endType'];
  end_date: string | null;
  end_count: number | null;
}

function rowToRule(r: RecurrenceRow): TaskRecurrenceInfo {
  return {
    id: r.id,
    isActive: r.is_active,
    frequency: r.frequency,
    interval: r.interval,
    byweekday: r.byweekday,
    endType: r.end_type,
    endDate: r.end_date,
    endCount: r.end_count,
  };
}

/** Today (Asia/Jerusalem) as a UTC-midnight Date — the materialization floor and
 *  the base for the horizon. Matches the app's Asia/Jerusalem date convention. */
function todayInJerusalem(): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parseDateOnly(ymd) ?? new Date(Date.UTC(1970, 0, 1));
}

/** The active rule attached to a task (via tasks.recurrence_id), or null. */
export async function getRecurrenceById(recurrenceId: string): Promise<TaskRecurrenceInfo | null> {
  const r = await queryOne<RecurrenceRow>(
    `select id, is_active, frequency, interval, byweekday,
            end_type, end_date::text as end_date, end_count
       from public.task_recurrences where id = $1`,
    [recurrenceId],
  );
  return r ? rowToRule(r) : null;
}

/** Insert/update the single rule row for a template task. Returns the rule id. */
async function upsertTaskRecurrence(
  client: PoolClient,
  taskId: string,
  rule: RecurrenceRule,
): Promise<string> {
  const byweekday = rule.frequency === 'weekly' ? rule.byweekday : null;
  const r = await client.query<{ id: string }>(
    `insert into public.task_recurrences
       (task_id, is_active, frequency, interval, byweekday, end_type, end_date, end_count)
     values ($1, true, $2, $3, $4, $5, $6, $7)
     on conflict (task_id) do update set
       is_active  = true,
       frequency  = excluded.frequency,
       interval   = excluded.interval,
       byweekday  = excluded.byweekday,
       end_type   = excluded.end_type,
       end_date   = excluded.end_date,
       end_count  = excluded.end_count
     returning id`,
    [taskId, rule.frequency, rule.interval, byweekday, rule.endType, rule.endDate, rule.endCount],
  );
  return r.rows[0].id;
}

/**
 * Apply the recurrence side-channel after a task save.
 *  - rule === null → end + detach: deactivate any rule and clear the template flag
 *    (existing instances are kept; history is never destroyed).
 *  - rule present  → upsert the rule, mark the saved task as the TEMPLATE (its due
 *    date is the series anchor / first occurrence), then materialize.
 */
export async function applyRecurrenceOnSave(
  taskId: string,
  rule: RecurrenceRule | null,
  dueDate: string | null,
  _actorId: string | null,
): Promise<void> {
  if (rule === null) {
    await withTransaction(async (c) => {
      await c.query(`update public.task_recurrences set is_active = false where task_id = $1`, [taskId]);
      await c.query(
        `update public.tasks
            set is_recurring_template = false, recurrence_id = null, occurrence_date = null
          where id = $1`,
        [taskId],
      );
    });
    return;
  }

  await withTransaction(async (c) => {
    const recId = await upsertTaskRecurrence(c, taskId, rule);
    await c.query(
      `update public.tasks
          set recurrence_id = $2,
              is_recurring_template = true,
              is_recurring_instance = false,
              parent_task_id = null,
              occurrence_date = $3
        where id = $1`,
      [taskId, recId, dueDate],
    );
  });

  await materializeDue(taskId);
}

interface TemplateRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  due_time: string | null;
  target_type: string | null;
  target_id: string | null;
  recurrence_id: string | null;
  anchor: string | null; // occurrence_date ?? due_date, as 'YYYY-MM-DD'
  created_by: string | null;
  created_by_name: string | null;
}

/**
 * Ensure task INSTANCES exist for every occurrence of a template's rule up to
 * HORIZON_DAYS ahead. Idempotent (one row per recurrence_id + occurrence_date —
 * the template occupies the anchor occurrence, so only the future ones become
 * instances). Past, never-materialized dates are NOT back-filled. Inactive /
 * exhausted rules produce nothing. Returns how many instances were created.
 */
export async function materializeDue(templateTaskId: string): Promise<number> {
  const tpl = await queryOne<TemplateRow>(
    `select id, title, description, priority,
            due_time::text as due_time, target_type, target_id, recurrence_id,
            coalesce(occurrence_date, due_date)::text as anchor,
            created_by, created_by_name
       from public.tasks where id = $1`,
    [templateTaskId],
  );
  if (!tpl || !tpl.recurrence_id || !tpl.anchor) return 0;

  const rule = await getRecurrenceById(tpl.recurrence_id);
  if (!rule || !rule.isActive) return 0;

  const anchor = parseDateOnly(tpl.anchor);
  if (!anchor) return 0;

  const today = todayInJerusalem();
  const todayStr = formatDateOnly(today);
  const horizon = new Date(today.getTime());
  horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);

  const excRows = await query<{ excluded_date: string }>(
    `select excluded_date::text as excluded_date
       from public.task_recurrence_exceptions where recurrence_id = $1`,
    [tpl.recurrence_id],
  );
  const excluded = new Set(excRows.rows.map((r) => r.excluded_date));

  const occurrences = computeOccurrences(rule, anchor, horizon, excluded).map(formatDateOnly);
  if (occurrences.length === 0) return 0;

  // Already-present occurrence dates for this series (template anchor + existing
  // instances) — skip them. Detached occurrences have recurrence_id=null and so
  // are protected by their exception row instead.
  const existingRows = await query<{ occurrence_date: string }>(
    `select occurrence_date::text as occurrence_date
       from public.tasks
      where recurrence_id = $1 and occurrence_date is not null`,
    [tpl.recurrence_id],
  );
  const existing = new Set(existingRows.rows.map((r) => r.occurrence_date));

  const missing = occurrences.filter((d) => !existing.has(d) && d >= todayStr);
  if (missing.length === 0) {
    await query(`update public.task_recurrences set last_spawned_at = now() where id = $1`, [tpl.recurrence_id]);
    return 0;
  }

  let created = 0;
  await withTransaction(async (c) => {
    const sortRes = await c.query<{ m: number }>(
      `select coalesce(max(sort_order), -1) as m from public.tasks where status = 'open'`,
    );
    let nextSort = (sortRes.rows[0]?.m ?? -1) + 1;

    for (const occ of missing) {
      const row = await c.query<{ id: string }>(
        `insert into public.tasks
           (title, description, status, priority, due_date, due_time,
            target_type, target_id, sort_order,
            recurrence_id, is_recurring_instance, parent_task_id, occurrence_date,
            created_by, created_by_name)
         values ($1, $2, 'open', $3, $4, $5,
                 $6, $7, $8,
                 $9, true, $10, $11,
                 $12, $13)
         on conflict do nothing
         returning id`,
        [
          tpl.title, tpl.description, tpl.priority, occ, tpl.due_time,
          tpl.target_type, tpl.target_id, nextSort,
          tpl.recurrence_id, tpl.id, occ,
          tpl.created_by, tpl.created_by_name,
        ],
      );
      const newId = row.rows[0]?.id;
      if (!newId) continue; // raced / conflict — already exists
      await copyEntityAssignees(c, 'task', tpl.id, 'task', newId, tpl.created_by);
      created += 1;
      nextSort += 1;
    }

    await c.query(
      `update public.task_recurrences
          set last_spawned_at = now(), spawned_count = spawned_count + $2
        where id = $1`,
      [tpl.recurrence_id, created],
    );
  });

  return created;
}

/** Materialize every active series — called from the tasks list loader. Each
 *  template is best-effort; one failure never blocks the others or the page. */
export async function materializeAllActive(): Promise<void> {
  const r = await query<{ id: string }>(
    `select t.id
       from public.tasks t
       join public.task_recurrences r on r.id = t.recurrence_id
      where t.is_recurring_template = true
        and t.is_archived = false
        and r.is_active = true`,
  );
  for (const row of r.rows) {
    try {
      await materializeDue(row.id);
    } catch (err) {
      console.error('[materializeAllActive]', row.id, err);
    }
  }
}

// ── Per-occurrence series actions (edit drawer) ──────────────────────────────

interface SeriesTaskRow {
  recurrence_id: string | null;
  occurrence_date: string | null;
  is_recurring_instance: boolean;
}

async function loadSeriesTask(client: PoolClient, taskId: string): Promise<SeriesTaskRow | null> {
  const r = await client.query<SeriesTaskRow>(
    `select recurrence_id, occurrence_date::text as occurrence_date, is_recurring_instance
       from public.tasks where id = $1`,
    [taskId],
  );
  return r.rows[0] ?? null;
}

/** End the whole series: deactivate the rule. Existing instances are kept. */
export async function endTaskSeries(taskId: string): Promise<boolean> {
  const t = await queryOne<{ recurrence_id: string | null }>(
    `select recurrence_id from public.tasks where id = $1`,
    [taskId],
  );
  if (!t || !t.recurrence_id) return false;
  await query(`update public.task_recurrences set is_active = false where id = $1`, [t.recurrence_id]);
  return true;
}

/** Skip THIS occurrence: record an exception and remove the (regenerable)
 *  instance row. Instances only — never the template. */
export async function skipTaskOccurrence(taskId: string): Promise<boolean> {
  return withTransaction(async (c) => {
    const row = await loadSeriesTask(c, taskId);
    if (!row || !row.recurrence_id || !row.occurrence_date || !row.is_recurring_instance) return false;
    await c.query(
      `insert into public.task_recurrence_exceptions (recurrence_id, excluded_date)
       values ($1, $2) on conflict do nothing`,
      [row.recurrence_id, row.occurrence_date],
    );
    await c.query(`delete from public.entity_assignees where entity_type = 'task' and entity_id = $1`, [taskId]);
    await c.query(`delete from public.reminders where entity_type = 'task' and entity_id = $1`, [taskId]);
    await c.query(`delete from public.tasks where id = $1`, [taskId]);
    return true;
  });
}

/** Detach THIS occurrence into a standalone task: record an exception (so the
 *  materializer won't re-create it) and clear the recurrence linkage. Instances
 *  only. */
export async function detachTaskOccurrence(taskId: string): Promise<boolean> {
  return withTransaction(async (c) => {
    const row = await loadSeriesTask(c, taskId);
    if (!row || !row.recurrence_id || !row.occurrence_date || !row.is_recurring_instance) return false;
    await c.query(
      `insert into public.task_recurrence_exceptions (recurrence_id, excluded_date)
       values ($1, $2) on conflict do nothing`,
      [row.recurrence_id, row.occurrence_date],
    );
    await c.query(
      `update public.tasks
          set recurrence_id = null, is_recurring_instance = false,
              parent_task_id = null, occurrence_date = null
        where id = $1`,
      [taskId],
    );
    return true;
  });
}

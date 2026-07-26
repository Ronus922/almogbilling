import 'server-only';
import type { PoolClient } from 'pg';
import { queryOne, withTransaction } from '@/lib/db';
import { copyEntityAssignees } from '@/lib/db/entityAssignees';
import {
  nextOccurrenceAfter,
  parseDateOnly,
  type RecurrenceRule,
} from '@/lib/recurrence/engine';

// Server-side recurrence series operations (migration 067 — SINGLE-ROW model).
//
// A recurring task is exactly ONE tasks row:
//   * tasks.due_date              → the CURRENT occurrence.
//   * task_recurrences.anchor_date → the series origin, immutable. All interval
//     and `after_count` math is measured from here, so advancing due_date never
//     re-phases the series.
//   * task_occurrence_completions  → the history due_date no longer carries.
//
// Nothing is materialized ahead of time, so there is no cron and no per-page
// generation step. Reminders stay attached to the single row and keep firing for
// each occurrence as its due date approaches (lib/db/tasks.listTasksDueSoon).

/** A recurrence rule + its identity/state, as the form and detail API need it. */
export interface TaskRecurrenceInfo extends RecurrenceRule {
  id: string;
  isActive: boolean;
  /** Series origin ('YYYY-MM-DD') — drives the derived cadence chips. */
  anchorDate: string;
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
  anchor_date: string;
}

const RECURRENCE_COLUMNS = `
  id, is_active, frequency, interval, byweekday,
  end_type, end_date::text as end_date, end_count,
  anchor_date::text as anchor_date
`;

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
    anchorDate: r.anchor_date,
  };
}

/** The rule attached to a task (via tasks.recurrence_id), or null. */
export async function getRecurrenceById(recurrenceId: string): Promise<TaskRecurrenceInfo | null> {
  const r = await queryOne<RecurrenceRow>(
    `select ${RECURRENCE_COLUMNS} from public.task_recurrences where id = $1`,
    [recurrenceId],
  );
  return r ? rowToRule(r) : null;
}

// ── Rule persistence ────────────────────────────────────────────────────────

/**
 * Apply the recurrence side-channel after a task save.
 *  - `rule === null` → end the series: deactivate the rule and detach the task.
 *    The completion history is kept (it cascades with the task, not the rule).
 *  - rule present → upsert the rule and mark the task as the series row.
 *
 * `dueDateChanged` guards the anchor: it is (re)set only when the caller actually
 * moved the due date, or when the series has no anchor yet. Without that guard
 * every plain re-save of a recurring task would re-base the series onto its
 * CURRENT occurrence, restarting an `after_count` limit and re-phasing any
 * interval > 1.
 */
export async function applyRecurrenceOnSave(
  taskId: string,
  rule: RecurrenceRule | null,
  dueDate: string | null,
  dueDateChanged: boolean,
): Promise<void> {
  if (rule === null) {
    await withTransaction(async (c) => {
      await c.query(
        `update public.task_recurrences set is_active = false where task_id = $1`,
        [taskId],
      );
      await c.query(
        `update public.tasks
            set is_recurring_template = false, recurrence_id = null
          where id = $1`,
        [taskId],
      );
    });
    return;
  }

  await withTransaction(async (c) => {
    const byweekday = rule.frequency === 'weekly' ? rule.byweekday : null;
    const r = await c.query<{ id: string }>(
      `insert into public.task_recurrences
         (task_id, is_active, frequency, interval, byweekday,
          end_type, end_date, end_count, anchor_date)
       values ($1, true, $2, $3, $4, $5, $6, $7, $8)
       on conflict (task_id) do update set
         is_active   = true,
         frequency   = excluded.frequency,
         interval    = excluded.interval,
         byweekday   = excluded.byweekday,
         end_type    = excluded.end_type,
         end_date    = excluded.end_date,
         end_count   = excluded.end_count,
         -- Keep the existing origin unless the due date actually moved.
         anchor_date = case when $9 then excluded.anchor_date
                            else task_recurrences.anchor_date end
       returning id`,
      [
        taskId, rule.frequency, rule.interval, byweekday,
        rule.endType, rule.endDate, rule.endCount, dueDate,
        dueDateChanged,
      ],
    );
    await c.query(
      `update public.tasks
          set recurrence_id = $2, is_recurring_template = true
        where id = $1`,
      [taskId, r.rows[0].id],
    );
  });
}

// ── Advancing the single row ────────────────────────────────────────────────

export interface OccurrenceAdvance {
  /** The occurrence that was just closed. */
  occurrence_date: string;
  /** The new due date, or null when the series has no occurrence left. */
  next_due_date: string | null;
}

interface SeriesRow {
  id: string;
  due_date: string | null;
  recurrence_id: string;
}

/** Load + lock the series row, or null when the task is not an ACTIVE series. */
async function lockSeries(
  c: PoolClient,
  taskId: string,
): Promise<{ task: SeriesRow; rule: TaskRecurrenceInfo } | null> {
  const t = await c.query<SeriesRow>(
    `select id, due_date::text as due_date, recurrence_id
       from public.tasks where id = $1 for update`,
    [taskId],
  );
  const task = t.rows[0];
  if (!task || !task.recurrence_id) return null;

  const r = await c.query<RecurrenceRow>(
    `select ${RECURRENCE_COLUMNS} from public.task_recurrences where id = $1 for update`,
    [task.recurrence_id],
  );
  const row = r.rows[0];
  if (!row || !row.is_active) return null;
  return { task, rule: rowToRule(row) };
}

async function loadExceptions(c: PoolClient, recurrenceId: string): Promise<Set<string>> {
  const r = await c.query<{ excluded_date: string }>(
    `select excluded_date::text as excluded_date
       from public.task_recurrence_exceptions where recurrence_id = $1`,
    [recurrenceId],
  );
  return new Set(r.rows.map((x) => x.excluded_date));
}

/**
 * Move the series row off its current occurrence. Shared by complete / skip /
 * detach so the "what is the next date, and what if there isn't one" decision
 * lives in exactly one place.
 */
async function advanceWithin(
  c: PoolClient,
  task: SeriesRow,
  rule: TaskRecurrenceInfo,
  opts: {
    /** Log the closed occurrence as done (complete), or not (skip). */
    completedBy: { id: string | null; name: string | null } | null;
    /** Record the closed occurrence as an exception so it can't come back. */
    addException: boolean;
  },
): Promise<OccurrenceAdvance> {
  const occurrence = task.due_date ?? rule.anchorDate;

  if (opts.completedBy) {
    await c.query(
      `insert into public.task_occurrence_completions
         (task_id, recurrence_id, occurrence_date, completed_by, completed_by_name)
       values ($1, $2, $3, $4, $5)
       on conflict (task_id, occurrence_date) do nothing`,
      [task.id, rule.id, occurrence, opts.completedBy.id, opts.completedBy.name],
    );
  }
  if (opts.addException) {
    await c.query(
      `insert into public.task_recurrence_exceptions (recurrence_id, excluded_date)
       values ($1, $2) on conflict do nothing`,
      [rule.id, occurrence],
    );
  }

  const anchor = parseDateOnly(rule.anchorDate);
  const after = parseDateOnly(occurrence);
  const next =
    anchor && after
      ? nextOccurrenceAfter(rule, anchor, after, await loadExceptions(c, rule.id))
      : null;

  if (next) {
    // The row lives on: it just points at the next occurrence.
    await c.query(
      `update public.tasks
          set due_date = $2, status = 'open', completed_at = null
        where id = $1`,
      [task.id, next],
    );
  } else {
    // Series finished (after_count exhausted / end date passed) — the row
    // becomes an ordinary completed task and the rule goes dormant.
    await c.query(
      `update public.tasks set status = 'done', completed_at = now() where id = $1`,
      [task.id],
    );
    await c.query(
      `update public.task_recurrences set is_active = false where id = $1`,
      [rule.id],
    );
  }

  return { occurrence_date: occurrence, next_due_date: next };
}

/**
 * Complete THIS occurrence: log it and advance the row to the next one. Returns
 * null when the task is not an active series row (the caller should then apply a
 * plain status update instead).
 */
export async function completeRecurringOccurrence(
  taskId: string,
  actor: { id: string | null; name: string | null },
): Promise<OccurrenceAdvance | null> {
  return withTransaction(async (c) => {
    const loaded = await lockSeries(c, taskId);
    if (!loaded) return null;
    return advanceWithin(c, loaded.task, loaded.rule, {
      completedBy: actor,
      addException: false,
    });
  });
}

/**
 * Skip THIS occurrence: record an exception (so it is never offered again) and
 * advance — without logging a completion, because nothing was done.
 */
export async function skipTaskOccurrence(taskId: string): Promise<OccurrenceAdvance | null> {
  return withTransaction(async (c) => {
    const loaded = await lockSeries(c, taskId);
    if (!loaded) return null;
    return advanceWithin(c, loaded.task, loaded.rule, {
      completedBy: null,
      addException: true,
    });
  });
}

/** Fields copied when an occurrence is detached into a standalone task. */
const DETACH_COLUMNS = [
  'title', 'description', 'status', 'priority', 'due_date', 'due_time',
  'debtor_id', 'apartment_number', 'related_entity_type', 'related_entity_id',
  'target_type', 'target_id', 'created_by', 'created_by_name',
] as const;

export interface DetachResult extends OccurrenceAdvance {
  /** The standalone task that now owns the detached occurrence. */
  detached_task_id: string;
}

/**
 * "ערוך רק את המופע הזה" — split THIS occurrence off into an independent task
 * (assignees included), exclude its date from the series, and advance the series
 * row to the next occurrence. The inverse of the old instance model, where the
 * occurrence already had its own row and merely got unlinked.
 */
export async function detachTaskOccurrence(
  taskId: string,
  actorId: string | null,
): Promise<DetachResult | null> {
  return withTransaction(async (c) => {
    const loaded = await lockSeries(c, taskId);
    if (!loaded) return null;

    const cols = DETACH_COLUMNS.join(', ');
    const inserted = await c.query<{ id: string }>(
      `insert into public.tasks (${cols}, sort_order)
       select ${cols},
              (select coalesce(max(sort_order), -1) + 1 from public.tasks where status = t.status)
         from public.tasks t
        where t.id = $1
       returning id`,
      [taskId],
    );
    const detachedId = inserted.rows[0]?.id;
    if (!detachedId) throw new Error('failed_to_detach_occurrence');
    await copyEntityAssignees(c, 'task', taskId, 'task', detachedId, actorId);

    const advance = await advanceWithin(c, loaded.task, loaded.rule, {
      completedBy: null,
      addException: true,
    });
    return { ...advance, detached_task_id: detachedId };
  });
}

/**
 * End the whole series: the rule goes dormant and the task becomes an ordinary
 * one (keeping its current due date and its completion history). Nothing is
 * deleted — under the single-row model there are no future rows to clean up.
 * Idempotent.
 */
export async function endTaskSeries(taskId: string): Promise<boolean> {
  const t = await queryOne<{ recurrence_id: string | null }>(
    `select recurrence_id from public.tasks where id = $1`,
    [taskId],
  );
  if (!t || !t.recurrence_id) return false;
  await withTransaction(async (c) => {
    await c.query(
      `update public.task_recurrences set is_active = false where id = $1`,
      [t.recurrence_id],
    );
    await c.query(
      `update public.tasks set is_recurring_template = false, recurrence_id = null where id = $1`,
      [taskId],
    );
  });
  return true;
}

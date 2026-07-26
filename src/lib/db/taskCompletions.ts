import 'server-only';
import { query } from '@/lib/db';
import type { TaskOccurrenceCompletion } from '@/lib/types/tasks';

// Completion history for recurring tasks (migration 067). Under the single-row
// model the task row itself no longer records "this occurrence was done" — it has
// already moved on to the next date — so the log is what powers the per-period
// progress badge ("1/3 השבוע"), the green day/month chips, and the history list
// in the edit panel.
//
// The write side lives in lib/recurrence/series.ts, inside the same transaction
// that advances the row, so a completion can never be logged without the row
// moving (or vice versa).

/** Occurrence dates completed for each of `taskIds` inside [from, to]. Batched:
 *  one query for a whole list page, keyed by task id. */
export async function listCompletionDatesInRange(
  taskIds: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, string[]>> {
  const byTask = new Map<string, string[]>();
  if (taskIds.length === 0) return byTask;

  const r = await query<{ task_id: string; occurrence_date: string }>(
    `select task_id, occurrence_date::text as occurrence_date
       from public.task_occurrence_completions
      where task_id = any($1::uuid[])
        and occurrence_date >= $2::date
        and occurrence_date <= $3::date
      order by occurrence_date asc`,
    [[...taskIds], from, to],
  );
  for (const row of r.rows) {
    const list = byTask.get(row.task_id);
    if (list) list.push(row.occurrence_date);
    else byTask.set(row.task_id, [row.occurrence_date]);
  }
  return byTask;
}

/** Full completion history of one task, newest first — for the edit panel. */
export async function listCompletionsForTask(
  taskId: string,
  limit = 50,
): Promise<TaskOccurrenceCompletion[]> {
  const r = await query<TaskOccurrenceCompletion>(
    `select id, task_id, occurrence_date::text as occurrence_date,
            completed_at::text as completed_at, completed_by, completed_by_name
       from public.task_occurrence_completions
      where task_id = $1
      order by occurrence_date desc
      limit $2`,
    [taskId, limit],
  );
  return r.rows;
}

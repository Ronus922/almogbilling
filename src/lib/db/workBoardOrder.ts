import 'server-only';
import { query } from '@/lib/db';
import type { WorkItemKind } from '@/lib/types/workItems';

// Per-user, per-module board customization for /issues and /tasks
// (13/10/2026) — public.user_work_board_order. See the migration comment for
// why this is a single full-replace row rather than a position-per-row table
// like public.user_reminder_order: the ordered thing here (which lanes, and
// in what order) is small and always rewritten whole, never grown
// incrementally. Each element is an employee uuid, or the SUPPLIERS_LANE_ID
// sentinel for the combined "ספקים" lane (14/10/2026) — employee_ids is
// text[], not uuid[], for exactly that reason.

/** The viewer's saved lane set for `kind`, in order — null = never
 *  customized, the caller falls back to the default algorithm. */
export async function getWorkBoardOrder(userId: string, kind: WorkItemKind): Promise<string[] | null> {
  const r = await query<{ employee_ids: string[] }>(
    `select employee_ids from public.user_work_board_order where user_id = $1 and kind = $2`,
    [userId, kind],
  );
  return r.rows[0]?.employee_ids ?? null;
}

/** Replace the viewer's saved lane set for `kind` with `employeeIds`, in the
 *  given order. An empty array is a valid, deliberate choice (hide every
 *  lane) — distinct from no row at all (never customized). */
export async function setWorkBoardOrder(userId: string, kind: WorkItemKind, employeeIds: string[]): Promise<void> {
  await query(
    `insert into public.user_work_board_order (user_id, kind, employee_ids, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id, kind) do update
       set employee_ids = excluded.employee_ids,
           updated_at = now()`,
    [userId, kind, employeeIds],
  );
}

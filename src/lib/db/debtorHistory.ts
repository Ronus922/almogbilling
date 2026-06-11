import 'server-only';
import { query } from '@/lib/db';
import type { DebtorEventType } from '@/lib/debtor-events';

export type HistorySource = 'comment' | 'status' | 'action' | 'event';

export interface DebtorHistoryEntry {
  id: string;
  source: HistorySource;
  event_type: DebtorEventType | null;
  title: string;
  description: string | null;
  outcome: string | null;
  actor_name: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export const HISTORY_LIMIT_DEFAULT = 100;
export const HISTORY_LIMIT_MAX = 300;

/**
 * Unified, time-ordered timeline for one debtor. Merges four sources into a
 * single shape with one `UNION ALL` (normalised columns) so there is no N+1 and
 * the ordering/limit happen in SQL.
 *   comment → public.comments
 *   status  → public.legal_status_history (source kept in metadata)
 *   action  → public.completed_actions
 *   event   → public.debtor_events (manual docs + system events)
 */
export async function listDebtorHistory(
  debtorId: string,
  limit = HISTORY_LIMIT_DEFAULT,
): Promise<DebtorHistoryEntry[]> {
  const safeLimit = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(limit) || HISTORY_LIMIT_DEFAULT));

  const r = await query<DebtorHistoryEntry>(
    `
    select * from (
      select
        c.id::text                          as id,
        'comment'                           as source,
        null::text                          as event_type,
        'הערה'                              as title,
        c.content                           as description,
        null::text                          as outcome,
        c.author_name                       as actor_name,
        c.created_at                        as created_at,
        '{}'::jsonb                         as metadata
      from public.comments c
      where c.debtor_id = $1

      union all

      select
        h.id::text                          as id,
        'status'                            as source,
        null::text                          as event_type,
        'שינוי סטטוס: '
          || coalesce(h.old_status_name, 'ללא סטטוס')
          || ' ← '
          || coalesce(h.new_status_name, 'ללא סטטוס')  as title,
        null::text                          as description,
        null::text                          as outcome,
        h.changed_by_name                   as actor_name,
        h.changed_at                        as created_at,
        jsonb_build_object('source', h.source) as metadata
      from public.legal_status_history h
      where h.debtor_id = $1

      union all

      select
        a.id::text                          as id,
        'action'                            as source,
        null::text                          as event_type,
        'פעולה הושלמה'                      as title,
        a.description                       as description,
        null::text                          as outcome,
        a.completed_by_name                 as actor_name,
        a.completed_at                      as created_at,
        '{}'::jsonb                         as metadata
      from public.completed_actions a
      where a.debtor_id = $1

      union all

      select
        e.id::text                          as id,
        'event'                             as source,
        e.event_type                        as event_type,
        e.title                             as title,
        e.description                       as description,
        e.outcome                           as outcome,
        e.actor_name                        as actor_name,
        e.created_at                        as created_at,
        e.metadata                          as metadata
      from public.debtor_events e
      where e.debtor_id = $1
    ) t
    order by t.created_at desc
    limit $2
    `,
    [debtorId, safeLimit],
  );
  return r.rows;
}

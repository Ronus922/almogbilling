import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { SyncStage } from '@/lib/sync/decision';

export type SyncStatus = 'running' | 'success' | 'error';
export type SyncTriggerSource = 'ui' | 'cron';

export interface SyncRun {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: SyncStatus;
  error_stage: SyncStage | null;
  error_message: string | null;
  /** last_import_at of the CRM snapshot the run read — when Bllink was actually scraped. */
  source_run_at: Date | null;
  rows_count: number | null;
  import_run_id: string | null;
  trigger_source: SyncTriggerSource;
  triggered_by: string | null;
}

export interface SyncRunListItem extends SyncRun {
  triggered_by_email: string | null;
}

const COLUMNS = `id, started_at, finished_at, status, error_stage, error_message,
                 source_run_at, rows_count, import_run_id, trigger_source, triggered_by`;

/** Open a sync_run row (status='running') at the start of a sync. */
export async function createSyncRun(opts: {
  triggeredBy: string | null;
  source: SyncTriggerSource;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.sync_runs (triggered_by, trigger_source) values ($1, $2) returning id`,
    [opts.triggeredBy, opts.source],
  );
  if (!row) throw new Error('Failed to create sync_run');
  return row.id;
}

export async function finishSyncRunSuccess(
  runId: string,
  opts: { sourceRunAt: string | null; rowsCount: number; importRunId: string | null },
): Promise<void> {
  await query(
    `update public.sync_runs
        set status = 'success', finished_at = now(),
            source_run_at = $2, rows_count = $3, import_run_id = $4
      where id = $1`,
    [runId, opts.sourceRunAt, opts.rowsCount, opts.importRunId],
  );
}

export async function finishSyncRunError(
  runId: string,
  opts: { stage: SyncStage; message: string; sourceRunAt: string | null; importRunId?: string | null },
): Promise<void> {
  await query(
    `update public.sync_runs
        set status = 'error', finished_at = now(),
            error_stage = $2, error_message = $3, source_run_at = $4, import_run_id = $5
      where id = $1`,
    [runId, opts.stage, opts.message.slice(0, 4000), opts.sourceRunAt, opts.importRunId ?? null],
  );
}

/** The most recent run of any status (what the banner reports on). */
export async function getLastSyncRun(): Promise<SyncRun | null> {
  return queryOne<SyncRun>(
    `select ${COLUMNS} from public.sync_runs order by started_at desc limit 1`,
  );
}

/** The most recent SUCCESSFUL run — its source_run_at is "the data is correct as of". */
export async function getLastSuccessfulSyncRun(): Promise<SyncRun | null> {
  return queryOne<SyncRun>(
    `select ${COLUMNS} from public.sync_runs
      where status = 'success'
      order by started_at desc limit 1`,
  );
}

/** Newest-first history for the admin panel. */
export async function listRecentSyncRuns(limit = 30): Promise<SyncRunListItem[]> {
  const r = await query<SyncRunListItem>(
    `select s.id, s.started_at, s.finished_at, s.status, s.error_stage, s.error_message,
            s.source_run_at, s.rows_count, s.import_run_id, s.trigger_source, s.triggered_by,
            u.email as triggered_by_email
       from public.sync_runs s
       left join public.users u on u.id = s.triggered_by
      order by s.started_at desc
      limit $1`,
    [limit],
  );
  return r.rows;
}

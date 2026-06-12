import 'server-only';
import { query, queryOne } from '@/lib/db';

export type SyncStatus = 'running' | 'success' | 'error';

export interface SyncRun {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: SyncStatus;
  error_message: string | null;
  triggered_by: string | null;
}

/** Open a sync_run row (status='running') at the start of a sync. */
export async function createSyncRun(userId: string | null): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.sync_runs (triggered_by) values ($1) returning id`,
    [userId],
  );
  if (!row) throw new Error('Failed to create sync_run');
  return row.id;
}

export async function finishSyncRunSuccess(runId: string): Promise<void> {
  await query(
    `update public.sync_runs
        set status = 'success', finished_at = now()
      where id = $1`,
    [runId],
  );
}

export async function finishSyncRunError(runId: string, message: string): Promise<void> {
  await query(
    `update public.sync_runs
        set status = 'error', finished_at = now(), error_message = $2
      where id = $1`,
    [runId, message.slice(0, 1000)],
  );
}

/** The finish time of the most recent SUCCESSFUL sync, or null if none. */
export async function getLastSuccessfulSyncAt(): Promise<Date | null> {
  const r = await queryOne<{ last_at: Date | null }>(
    `select max(finished_at) as last_at
       from public.sync_runs
      where status = 'success'`,
  );
  return r?.last_at ?? null;
}

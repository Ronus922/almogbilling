import 'server-only';
import { query, queryOne } from '@/lib/db';

export type ImportMode = 'merge' | 'replace';
export type ImportStatus = 'running' | 'success' | 'error';

export interface ImportRun {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  mode: ImportMode;
  status: ImportStatus;
  total_rows: number;
  processed_rows: number;
  updated_rows: number;
  created_rows: number;
  skipped_rows: number;
  error_message: string | null;
  initiated_by: string | null;
}

export async function createImportRun(mode: ImportMode, userId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.import_runs (mode, initiated_by) values ($1, $2) returning id`,
    [mode, userId],
  );
  if (!row) throw new Error('Failed to create import_run');
  return row.id;
}

export async function setRunTotal(runId: string, total: number): Promise<void> {
  await query(`update public.import_runs set total_rows = $2 where id = $1`, [runId, total]);
}

export async function bumpRunProgress(
  runId: string,
  delta: { processed?: number; updated?: number; created?: number; skipped?: number },
): Promise<void> {
  await query(
    `update public.import_runs
     set processed_rows = processed_rows + $2,
         updated_rows   = updated_rows   + $3,
         created_rows   = created_rows   + $4,
         skipped_rows   = skipped_rows   + $5
     where id = $1`,
    [runId, delta.processed ?? 0, delta.updated ?? 0, delta.created ?? 0, delta.skipped ?? 0],
  );
}

export async function finishRunSuccess(runId: string): Promise<void> {
  await query(
    `update public.import_runs
     set status = 'success', finished_at = now()
     where id = $1`,
    [runId],
  );
}

export async function finishRunError(runId: string, message: string): Promise<void> {
  await query(
    `update public.import_runs
     set status = 'error', finished_at = now(), error_message = $2
     where id = $1`,
    [runId, message.slice(0, 1000)],
  );
}

export async function getImportRun(runId: string): Promise<ImportRun | null> {
  return queryOne<ImportRun>(
    `select id, started_at, finished_at, mode, status,
            total_rows, processed_rows, updated_rows, created_rows, skipped_rows,
            error_message, initiated_by
     from public.import_runs
     where id = $1`,
    [runId],
  );
}

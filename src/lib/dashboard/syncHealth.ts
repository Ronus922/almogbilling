/**
 * Pure helpers for the dashboard's Bllink-sync health (red banner + indicator).
 * No DB / env imports so it is shared by server components, the client
 * indicator and unit tests.
 */
import type { SyncStage } from '@/lib/sync/decision';

export interface SyncRunSummary {
  id: string;
  status: 'running' | 'success' | 'error';
  startedAt: string; // ISO
  finishedAt: string | null;
  stage: SyncStage | null;
  message: string | null;
  /** When Bllink was actually scraped (source_run_at) — "the data is correct as of". */
  sourceRunAt: string | null;
  rowsCount: number | null;
  triggerSource: 'ui' | 'cron';
}

export type SyncHealth =
  | { state: 'ok'; sourceRunAt: string; ageHours: number }
  | { state: 'failed'; run: SyncRunSummary; sourceRunAt: string | null }
  | { state: 'stale'; sourceRunAt: string; ageHours: number; maxAgeHours: number }
  | { state: 'never' };

interface DbSyncRunLike {
  id: string;
  status: 'running' | 'success' | 'error';
  started_at: Date;
  finished_at: Date | null;
  error_stage: SyncStage | null;
  error_message: string | null;
  source_run_at: Date | null;
  rows_count: number | null;
  trigger_source: 'ui' | 'cron';
}

export function toSyncRunSummary(run: DbSyncRunLike | null): SyncRunSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.started_at.toISOString(),
    finishedAt: run.finished_at ? run.finished_at.toISOString() : null,
    stage: run.error_stage,
    message: run.error_message,
    sourceRunAt: run.source_run_at ? run.source_run_at.toISOString() : null,
    rowsCount: run.rows_count,
    triggerSource: run.trigger_source,
  };
}

/**
 * "The data is correct as of": the run's source_run_at, or — for successes
 * recorded before that column existed (pre-11/09/2026) — its finish time,
 * which is an honest upper bound (Bllink was scraped no later than that).
 * Without this, a legacy success reads as "never synced" on the dashboard.
 */
export function effectiveSourceRunAt(run: SyncRunSummary | null): string | null {
  if (!run || run.status !== 'success') return null;
  return run.sourceRunAt ?? run.finishedAt ?? run.startedAt;
}

/**
 * Banner rule (11/09/2026): red when the LAST run failed, or when the last
 * SUCCESSFUL run's source data is older than maxAgeHours, or when no run ever
 * succeeded. A run still in progress does not change the verdict.
 */
export function computeSyncHealth(input: {
  lastRun: SyncRunSummary | null;
  lastSuccess: SyncRunSummary | null;
  now: number;
  maxAgeHours: number;
}): SyncHealth {
  const { lastRun, lastSuccess, now, maxAgeHours } = input;
  if (lastRun && lastRun.status === 'error') {
    return { state: 'failed', run: lastRun, sourceRunAt: effectiveSourceRunAt(lastSuccess) };
  }
  if (!lastSuccess) return { state: 'never' };
  const anchor = effectiveSourceRunAt(lastSuccess) ?? lastSuccess.startedAt;
  const ageHours = (now - Date.parse(anchor)) / 36e5;
  if (ageHours > maxAgeHours) {
    return { state: 'stale', sourceRunAt: anchor, ageHours, maxAgeHours };
  }
  return { state: 'ok', sourceRunAt: anchor, ageHours };
}

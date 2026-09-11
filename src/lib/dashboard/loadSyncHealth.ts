import 'server-only';
import { getLastSyncRun, getLastSuccessfulSyncRun } from '@/lib/db/syncRuns';
import { computeSyncHealth, toSyncRunSummary, type SyncHealth, type SyncRunSummary } from '@/lib/dashboard/syncHealth';
import { BLLINK_MAX_SNAPSHOT_AGE_HOURS_DEFAULT } from '@/lib/constants';
import { env } from '@/env';

export interface SyncHealthSnapshot {
  lastRun: SyncRunSummary | null;
  lastSuccess: SyncRunSummary | null;
  /** When Bllink was last scraped successfully — "נתוני בלינק נכונים ל-". */
  sourceRunAt: Date | null;
  health: SyncHealth;
  maxAgeHours: number;
}

/** Reads the last two sync runs and derives the dashboard health in one call. */
export async function loadSyncHealth(): Promise<SyncHealthSnapshot> {
  const [lastRun, lastSuccess] = await Promise.all([getLastSyncRun(), getLastSuccessfulSyncRun()]);
  const maxAgeHours = Number(env.BLLINK_MAX_SNAPSHOT_AGE_HOURS ?? BLLINK_MAX_SNAPSHOT_AGE_HOURS_DEFAULT);
  const lastRunSummary = toSyncRunSummary(lastRun);
  const lastSuccessSummary = toSyncRunSummary(lastSuccess);
  return {
    lastRun: lastRunSummary,
    lastSuccess: lastSuccessSummary,
    sourceRunAt: lastSuccess?.source_run_at ?? null,
    health: computeSyncHealth({ lastRun: lastRunSummary, lastSuccess: lastSuccessSummary, now: Date.now(), maxAgeHours }),
    maxAgeHours,
  };
}

import { NextResponse } from 'next/server';
import { requireActor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { loadSyncHealth } from '@/lib/dashboard/loadSyncHealth';

export const runtime = 'nodejs';

// GET /api/sync/status — the dashboard freshness indicator's data in one call:
// the last run (any status), the last successful run (its source_run_at is
// "נתוני בלינק נכונים ל-") and the derived health for the red banner. Used to
// refresh the indicator after "סנכרן עכשיו".
export async function GET() {
  try {
    await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sync = await loadSyncHealth();
  return NextResponse.json({
    lastRun: sync.lastRun,
    lastSuccess: sync.lastSuccess,
    sourceRunAt: sync.sourceRunAt ? sync.sourceRunAt.toISOString() : null,
    // kept for older clients of this endpoint
    lastSyncAt: sync.lastSuccess?.finishedAt ?? null,
    health: sync.health,
    maxAgeHours: sync.maxAgeHours,
  });
}

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listRecentSyncRuns } from '@/lib/db/syncRuns';

export const runtime = 'nodejs';

// GET /api/sync/runs — the last 30 Bllink sync runs, newest first, for the
// admin history panel on the dashboard (SyncHistorySheet).
export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const runs = await listRecentSyncRuns(30);
  return NextResponse.json({ runs });
}

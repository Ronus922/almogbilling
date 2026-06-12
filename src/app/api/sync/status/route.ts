import { NextResponse } from 'next/server';
import { requireActor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getLastImportedAt } from '@/lib/db/debtors';
import { getLastSuccessfulSyncAt } from '@/lib/db/syncRuns';

export const runtime = 'nodejs';

// GET /api/sync/status — the dashboard freshness indicator's data in one call:
// the last file import (drives the freshness severity) and the last successful
// sync. Used to refresh the indicator after "סנכרן עכשיו".
export async function GET() {
  try {
    await requireActor();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const [lastImportAt, lastSyncAt] = await Promise.all([
    getLastImportedAt(),
    getLastSuccessfulSyncAt(),
  ]);

  return NextResponse.json({
    lastImportAt: lastImportAt ? lastImportAt.toISOString() : null,
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
  });
}

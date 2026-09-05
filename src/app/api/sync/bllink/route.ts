import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { createImportRun } from '@/lib/db/importRuns';
import { createSyncRun, finishSyncRunSuccess, finishSyncRunError } from '@/lib/db/syncRuns';
import { syncDebtorsFromCrm } from '@/lib/sync/bllinkPull';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { SYNC_BLLINK_MAX_PER_IP, AUTH_RATE_WINDOW_SEC } from '@/lib/constants';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * "Sync now" — refreshes the dashboard's debt data from Bllink.
 *
 * 1. Best-effort: trigger the CRM cron so it re-scrapes Bllink into the CRM's
 *    debtor_records (kept best-effort — a scrape failure must not block the
 *    pull, which can still merge the last good snapshot).
 * 2. Pull debtor_records into this app's public.debtors via the same merge
 *    pipeline as a manual import — this is what actually updates the data the
 *    dashboard reads and resets the freshness indicator (last_imported_at).
 */
export async function POST(req: Request) {
  let actorId: string;
  try {
    const actor = await requirePermission('import', 'edit');
    actorId = actor.id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // IP rate-limit (anti double-click / abuse). Runs AFTER auth so only
  // authenticated callers are counted, and BEFORE any sync side-effect so a
  // throttled request never triggers a CRM scrape or debtors merge.
  const { allowed, retryAfterSec } = await checkRateLimit('sync:bllink:ip:' + clientIp(req), {
    max: SYNC_BLLINK_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  // Step 1 — ask the CRM to re-scrape Bllink (best-effort; awaited so the pull
  // below sees the fresh snapshot when the scrape succeeds).
  const cronUrl = env.CRM_SYNC_URL;
  const cronSecret = env.CRM_CRON_SECRET;
  let scrapeTriggered = false;
  if (cronUrl && cronSecret) {
    try {
      const upstream = await fetch(cronUrl, {
        method: 'POST',
        headers: { 'x-cron-secret': cronSecret, 'content-type': 'application/json' },
        cache: 'no-store',
      });
      scrapeTriggered = upstream.ok;
    } catch {
      // ignore — fall through to pull the last good snapshot
    }
  }

  // Track this sync in its own ledger (sync_runs) — distinct from file imports.
  const syncRunId = await createSyncRun(actorId);

  // Step 2 — pull the CRM snapshot into public.debtors (this is the part that
  // actually refreshes the dashboard data).
  try {
    const runId = await createImportRun('merge', actorId);
    const merged = await syncDebtorsFromCrm(runId);
    await finishSyncRunSuccess(syncRunId);
    return NextResponse.json({
      ok: true,
      merged,
      scrapeTriggered,
      runId,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'sync_failed';
    await finishSyncRunError(syncRunId, message);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

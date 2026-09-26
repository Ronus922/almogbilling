import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { secretsMatch } from '@/lib/auth/cronSecret';
import { createImportRun } from '@/lib/db/importRuns';
import { createSyncRun, finishSyncRunSuccess, finishSyncRunError, type SyncTriggerSource } from '@/lib/db/syncRuns';
import { fetchCrmDebtorRows, writeCrmSnapshot } from '@/lib/sync/bllinkPull';
import { fetchLocalDebtorRows, recordWitnessCompare, type LocalSnapshot } from '@/lib/sync/localPull';
import { compareSnapshots, isCompareUnavailable, type CompareResult } from '@/lib/sync/bllinkCompare';
import {
  SyncStageError,
  checkSnapshotFreshness,
  localFreshnessLimitHours,
  parseCrmScrapeResponse,
  resolveBllinkSource,
  stageHttpStatus,
  type SyncStage,
} from '@/lib/sync/decision';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { SYNC_BLLINK_MAX_PER_IP, AUTH_RATE_WINDOW_SEC, BLLINK_MAX_SNAPSHOT_AGE_HOURS_DEFAULT } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { env } from '@/env';

export const runtime = 'nodejs';
// The CRM scrape alone takes ~45s (Playwright login + Excel export).
export const maxDuration = 180;

const SCRAPE_TIMEOUT_MS = 120_000;

/**
 * "Sync now" — refreshes the dashboard's debt data from Bllink. Callable by an
 * admin session (the dashboard button) or by billing-sync.timer with the
 * x-cron-secret header (constant-time compare against CRM_CRON_SECRET).
 *
 * Every run is a sync_runs row and walks four stages; the first failure stops
 * the run, is persisted with its stage + full message, is logged to the journal
 * and is returned as { ok:false, stage, message, sourceRunAt }:
 *
 *   scrape → POST CRM_SYNC_URL so the CRM re-scrapes Bllink. The CRM answers
 *            HTTP 200 even when the download failed (result.downloaded=false,
 *            result.errors[...]) — that is parsed, not trusted. (502)
 *   stale  → the CRM snapshot's last_import_at must be within
 *            BLLINK_MAX_SNAPSHOT_AGE_HOURS (default 36). A frozen snapshot is
 *            never copied again as if it were fresh. (409)
 *   guard  → completeness + reconciliation (writeCrmSnapshot). (409)
 *   pull   → fetching the snapshot / writing it. (502)
 *
 * Success returns { ok:true, stage:'done', sourceRunAt, merged, … } — the
 * dashboard shows sourceRunAt ("נתוני בלינק נכונים ל-"), never the copy time.
 *
 * ── BLLINK_SOURCE=billing (Phase 2, 26/09/2026) ──────────────────────────────
 * The snapshot comes from billing's OWN newest successful scrape
 * (bllink_scrapes, 05:30 Asia/Jerusalem) instead of the CRM:
 *   stale  → that scrape must be younger than BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS
 *            (strict, no default: unset = fail closed). Yesterday's snapshot is
 *            NEVER copied quietly — the run stops, sync_runs says why, nothing
 *            is written, and the failed unit alerts. (409)
 *   guard  → the same guards.                                            (409)
 *   pull   → the same write (importParsedRows: merge + zero-out).       (502)
 *   witness → AFTER the write and the success record, the CRM is asked for the
 *            same morning's report (triggerCrmScrape + fetchCrmDebtorRows) and
 *            compared with what was written; the result goes onto the scrape
 *            row (compare_summary). Best-effort: a CRM failure is a warning
 *            in the journal and `compare: unavailable`, never a failed sync.
 * sourceRunAt is then the scrape's finished_at — so the banner and the
 * freshness indicator watch billing's own scraper, not the CRM.
 */
export async function POST(req: Request) {
  // ── auth: machine job (header) or admin session ─────────────────────────
  let actorId: string | null = null;
  let source: SyncTriggerSource = 'ui';
  const cronHeader = req.headers.get('x-cron-secret');
  if (cronHeader !== null) {
    const expected = env.CRM_CRON_SECRET;
    if (!expected || !secretsMatch(cronHeader, expected)) {
      return NextResponse.json({ ok: false, stage: 'auth', message: 'unauthorized' }, { status: 401 });
    }
    source = 'cron';
  } else {
    try {
      const actor = await requirePermission('import', 'edit');
      actorId = actor.id;
    } catch (err) {
      const r = authErrorResponse(err);
      if (r) return r;
      throw err;
    }
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
      { ok: false, stage: 'rate_limit', message: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  const syncRunId = await createSyncRun({ triggeredBy: actorId, source });
  let sourceRunAt: string | null = null;
  let importRunId: string | null = null;
  const origin = resolveBllinkSource(env.BLLINK_SOURCE);

  try {
    if (origin === 'billing') {
      // ── stage: stale — billing's own newest scrape, and it must be today's ──
      const local = await fetchLocalDebtorRows(); // throws → 'pull' below
      if (!local) {
        throw new SyncStageError('stale', 'אין סריקה מוצלחת של billing ב-bllink_scrapes — לא הועתק דבר');
      }
      sourceRunAt = local.finishedAt;
      const limitHours = localFreshnessLimitHours(env.BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS);
      if (limitHours === null) {
        throw new SyncStageError(
          'stale',
          'BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS אינו מוגדר — במקור billing הסנכרון עוצר (fail-closed), לא הועתק דבר',
          sourceRunAt,
        );
      }
      const freshness = checkSnapshotFreshness(local.finishedAt, limitHours, Date.now());
      if (!freshness.fresh) {
        throw new SyncStageError(
          'stale',
          `הסריקה המוצלחת האחרונה של billing אינה מהיום — ${freshness.message}. לא הועתק דבר.`,
          sourceRunAt,
        );
      }

      // ── stages: guard + pull (write) — the same guards, the same write ──────
      importRunId = await createImportRun('merge', actorId);
      const merged = await writeCrmSnapshot(local.rows, local.report, importRunId);

      await finishSyncRunSuccess(syncRunId, { sourceRunAt, rowsCount: merged, importRunId });
      logger.info(
        `[bllink:sync] OK syncRun=${syncRunId} source=${source} origin=billing scrape=${local.scrapeId} merged=${merged} sourceRunAt=${sourceRunAt}`,
      );

      // ── witness: the CRM's report of the same morning, compared, off the data path ──
      const witness = await witnessCompare(local);
      return NextResponse.json({
        ok: true,
        stage: 'done',
        message: `סונכרנו ${merged} דירות`,
        sourceRunAt,
        merged,
        runId: importRunId,
        syncRunId,
        syncedAt: new Date().toISOString(),
        origin,
        witness: isCompareUnavailable(witness)
          ? { unavailable: witness.reason }
          : { crm_rows: witness.crm_rows, local_rows: witness.local_rows, diff_count: witness.diff_count, crm_snapshot_at: witness.crm_snapshot_at },
      });
    }

    // ── stage: scrape ──────────────────────────────────────────────────────
    await triggerCrmScrape();

    // ── stage: stale ───────────────────────────────────────────────────────
    const { rows, report } = await fetchCrmDebtorRows(); // throws → 'pull' below
    sourceRunAt = report.runMaxAt;
    const maxAgeHours = Number(env.BLLINK_MAX_SNAPSHOT_AGE_HOURS ?? BLLINK_MAX_SNAPSHOT_AGE_HOURS_DEFAULT);
    const freshness = checkSnapshotFreshness(report.runMaxAt, maxAgeHours, Date.now());
    if (!freshness.fresh) {
      throw new SyncStageError('stale', freshness.message, sourceRunAt);
    }

    // ── stages: guard + pull (write) ───────────────────────────────────────
    importRunId = await createImportRun('merge', actorId);
    const merged = await writeCrmSnapshot(rows, report, importRunId);

    await finishSyncRunSuccess(syncRunId, { sourceRunAt, rowsCount: merged, importRunId });
    logger.info(
      `[bllink:sync] OK syncRun=${syncRunId} source=${source} merged=${merged} sourceRunAt=${sourceRunAt ?? '?'}`,
    );
    return NextResponse.json({
      ok: true,
      stage: 'done',
      message: `סונכרנו ${merged} דירות`,
      sourceRunAt,
      merged,
      runId: importRunId,
      syncRunId,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const stage: SyncStage = err instanceof SyncStageError ? err.stage : 'pull';
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[bllink:sync] FAILED stage=${stage} syncRun=${syncRunId} source=${source} sourceRunAt=${sourceRunAt ?? '?'} — ${message}`,
    );
    await finishSyncRunError(syncRunId, { stage, message, sourceRunAt, importRunId });
    return NextResponse.json(
      { ok: false, stage, message, sourceRunAt },
      { status: stageHttpStatus(stage) },
    );
  }
}

/**
 * BLLINK_SOURCE=billing: after debtors were written from the local snapshot,
 * ask the CRM to scrape Bllink now and compare its report with what was
 * written — two independent readings of the same morning. The CRM is a
 * WITNESS: whatever happens here is logged and stored on the scrape row, and
 * NOTHING here can fail the sync (the run is already recorded as success).
 * A CRM that cannot be reached is `compare: unavailable`, a warning, no alert.
 */
async function witnessCompare(local: LocalSnapshot): Promise<CompareResult> {
  const comparedAt = new Date().toISOString();
  let result: CompareResult;
  try {
    await triggerCrmScrape();
    const crm = await fetchCrmDebtorRows();
    result = compareSnapshots(local.compareRows, crm.compareRows, {
      crmSnapshotAt: crm.report.runMaxAt,
      comparedBy: 'sync',
    });
    const line =
      `[bllink:witness] scrape=${local.scrapeId} local=${result.local_rows} crm=${result.crm_rows} ` +
      `missing=${result.missing.length} extra=${result.extra.length} field_diffs=${result.diffs.length} ` +
      `crm_snapshot_at=${result.crm_snapshot_at ?? '?'}`;
    if (result.diff_count > 0) logger.warn(line); else logger.info(line);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result = { compare: 'unavailable', reason, local_rows: local.compareRows.size, compared_by: 'sync', compared_at: comparedAt };
    logger.warn(`[bllink:witness] scrape=${local.scrapeId} CRM unavailable — warning only: ${reason}`);
  }
  try {
    await recordWitnessCompare(local.scrapeId, result);
  } catch (err) {
    logger.warn(`[bllink:witness] could not store the comparison: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/**
 * Asks the CRM to re-scrape Bllink and waits for the answer. Any outcome other
 * than a parsed, downloaded, error-free result is a stage-'scrape' failure
 * carrying the CRM's own error text.
 */
async function triggerCrmScrape(): Promise<void> {
  const cronUrl = env.CRM_SYNC_URL;
  const cronSecret = env.CRM_CRON_SECRET;
  if (!cronUrl || !cronSecret) {
    throw new SyncStageError('scrape', 'CRM_SYNC_URL / CRM_CRON_SECRET אינם מוגדרים — הסריקה לא הופעלה');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(cronUrl, {
      method: 'POST',
      headers: { 'x-cron-secret': cronSecret, 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `ה-CRM לא ענה תוך ${SCRAPE_TIMEOUT_MS / 1000} שניות`
      : `לא ניתן להגיע ל-CRM: ${err instanceof Error ? err.message : String(err)}`;
    throw new SyncStageError('scrape', reason);
  } finally {
    clearTimeout(timer);
  }

  const body: unknown = await res.json().catch(() => null);
  const outcome = parseCrmScrapeResponse(res.status, body);
  if (!outcome.ok) {
    throw new SyncStageError('scrape', outcome.message);
  }
}

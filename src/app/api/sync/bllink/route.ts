import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { secretsMatch } from '@/lib/auth/cronSecret';
import { createImportRun } from '@/lib/db/importRuns';
import { createSyncRun, finishSyncRunSuccess, finishSyncRunError, type SyncTriggerSource } from '@/lib/db/syncRuns';
import { writeCrmSnapshot } from '@/lib/sync/bllinkPull';
import { fetchLocalDebtorRows } from '@/lib/sync/localPull';
import { runScrapeUnit } from '@/lib/sync/scrapeUnit';
import {
  SyncStageError,
  checkSnapshotFreshness,
  localFreshnessLimitHours,
  stageHttpStatus,
  type SyncStage,
} from '@/lib/sync/decision';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { SYNC_BLLINK_MAX_PER_IP, AUTH_RATE_WINDOW_SEC } from '@/lib/constants';
import { syncBllinkBodySchema } from '@/lib/validation/requests';
import { logger } from '@/lib/logger';
import { suggestPortalLinks } from '@/lib/db/contactSuggestions';
import { env } from '@/env';

export const runtime = 'nodejs';
// "סנכרן עכשיו" waits for a real Bllink scrape (~20s) before the copy (~30s).
export const maxDuration = 180;

/**
 * "Sync now" — refreshes the dashboard's debt data from Bllink. Callable by an
 * admin session (the dashboard button) or by billing-sync.timer with the
 * x-cron-secret header (constant-time compare against CRM_CRON_SECRET — the
 * name is historical; it is billing's own timer secret).
 *
 * The snapshot is billing's OWN newest successful scrape of Bllink
 * (bllink_scrapes, billing-bllink-scrape.timer 05:30 Asia/Jerusalem). It is the
 * only source since the CRM (almog) was torn down on 06/10/2026; until then the
 * CRM was the source (≤26/09) and then a witness compared after the write.
 *
 * Every run is a sync_runs row and walks the stages below; the first failure stops
 * the run, is persisted with its stage + full message, is logged to the journal
 * and is returned as { ok:false, stage, message, sourceRunAt }:
 *
 *   scrape → ONLY when the caller posts {"fresh":true} (the dashboard button,
 *            27/09/2026): start billing-bllink-scrape.service and wait for it,
 *            so the button really refreshes instead of re-copying the morning
 *            snapshot. Refused for a cron caller — the timer scraped at 05:30.
 *            A unit that "succeeded" is not proof: it also exits 0 when another
 *            scrape holds the advisory lock, so the new snapshot's finished_at
 *            must post-date the request or the run fails here. (502)
 *   stale  → that scrape must be younger than BLLINK_LOCAL_MAX_SNAPSHOT_AGE_HOURS
 *            (strict, no default: unset = fail closed). Yesterday's snapshot is
 *            NEVER copied quietly — the run stops, sync_runs says why, nothing
 *            is written, and the failed unit alerts. (409)
 *   guard  → completeness + consistency of the snapshot (writeCrmSnapshot). (409)
 *   pull   → reading the snapshot / writing it (importParsedRows: merge +
 *            zero-out). (502)
 *   reconcile → AFTER the write (27/09/2026): the sums now in debtors, per
 *            category, must equal the report's and no apartment may be left
 *            with a balance the report dropped (reconcile.ts). The data IS
 *            written by then — the run is still an error and the banner red. (409)
 *
 * Success returns { ok:true, stage:'done', sourceRunAt, merged, … } — the
 * dashboard shows sourceRunAt ("נתוני בלינק נכונים ל-"), the scrape's
 * finished_at, never the copy time — so the banner and the freshness indicator
 * watch billing's own scraper.
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
  // throttled request never triggers a Bllink scrape or debtors merge.
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

  // ── the optional body ──────────────────────────────────────────────────
  // NOT parseJsonBody: billing-sync.timer posts no body at all, and
  // parseJsonBody answers 400 invalid_json for an empty one — the daily sync
  // must never depend on sending anything. An absent body reads as {}; a body
  // that IS sent is validated by the same zod schema and answered in the same
  // shape parseJsonBody uses (message + issues).
  let fresh = false;
  {
    const raw = (await req.text()).trim();
    if (raw.length > 0) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return NextResponse.json({ ok: false, stage: 'body', message: 'invalid_json' }, { status: 400 });
      }
      const parsed = syncBllinkBodySchema.safeParse(json);
      if (!parsed.success) {
        return NextResponse.json(
          {
            ok: false,
            stage: 'body',
            message: parsed.error.issues[0]?.message ?? 'invalid_body',
            issues: parsed.error.issues,
          },
          { status: 400 },
        );
      }
      // Only an operator may ask for a scrape. The timer already scraped at
      // 05:30, and a cron caller queueing a second Playwright run would double
      // the morning's memory for nothing.
      fresh = parsed.data.fresh === true && source === 'ui';
    }
  }

  const syncRunId = await createSyncRun({ triggeredBy: actorId, source });
  let sourceRunAt: string | null = null;
  let importRunId: string | null = null;

  try {
    // ── stage: scrape — a real Bllink scrape, only when asked for ──────────
    // Without this, "סנכרן עכשיו" re-copied the 05:30 snapshot: the numbers
    // never moved and the toast still said "סונכרנו" (found 27/09/2026 — five
    // manual runs, all with the same source_run_at).
    let scrapeAskedAt: number | null = null;
    if (fresh) {
      scrapeAskedAt = Date.now();
      const unit = await runScrapeUnit();
      if (!unit.ok) {
        throw new SyncStageError('scrape', `סריקת בלינק נכשלה — ${unit.reason}. לא הועתק דבר.`);
      }
    }

    // ── stage: stale — billing's own newest scrape, and it must be today's ──
    const local = await fetchLocalDebtorRows(); // throws → 'pull' below
    if (!local) {
      throw new SyncStageError('stale', 'אין סריקה מוצלחת של billing ב-bllink_scrapes — לא הועתק דבר');
    }
    sourceRunAt = local.finishedAt;

    // The unit exits 0 also when the scraper found the advisory lock taken and
    // skipped (scrapeLock.ts), so a successful unit is NOT proof of a new
    // snapshot — the timestamp is. Copying the older one here would answer
    // "סונכרנו" to a request for fresh data, which is the bug this stage fixes.
    if (scrapeAskedAt !== null && new Date(local.finishedAt).getTime() < scrapeAskedAt) {
      throw new SyncStageError(
        'scrape',
        'סריקה אחרת של בלינק רצה כרגע ולכן לא נוצרה סריקה חדשה — נסה שוב בעוד דקה. לא הועתק דבר.',
        sourceRunAt,
      );
    }
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

    // Bllink's people vs the portal links (03/10/2026): "שיוך" / "ניתוק"
    // suggestions in the queue — nothing is linked or unlinked here.
    // Best-effort, like the registry hook: a queue hiccup never fails a sync.
    try {
      const p = await suggestPortalLinks(local.scrapeId);
      logger.info(`[bllink:sync] portal links: +${p.suggested_link} link, +${p.suggested_unlink} unlink, +${p.suggested_name} name, ${p.closed} closed`);
    } catch (linkErr) {
      logger.error('[bllink:sync] portal link suggestions failed', linkErr instanceof Error ? linkErr.message : String(linkErr));
    }

    await finishSyncRunSuccess(syncRunId, { sourceRunAt, rowsCount: merged, importRunId });
    logger.info(
      `[bllink:sync] OK syncRun=${syncRunId} source=${source} scrape=${local.scrapeId} merged=${merged} sourceRunAt=${sourceRunAt}`,
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

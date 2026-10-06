import 'server-only';
import { getDbPool, query } from '@/lib/db';
import { importParsedRows } from '@/lib/import/runner';
import { finishRunError } from '@/lib/db/importRuns';
import { SyncStageError } from '@/lib/sync/decision';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { logger } from '@/lib/logger';
import { env } from '@/env';
import type { BllinkPullReport } from './bllinkMap';
import { reconcileAfterWrite, snapshotTotals } from './reconcile';
import { readDebtorsAfterWrite } from './reconcileRead';

export type { BllinkPullReport };

/**
 * Writes a Bllink debt snapshot — billing's own scrape (localPull.ts) — into
 * public.debtors, OVERWRITING it. (The name is historical: until 26/09/2026 the
 * snapshot came from the CRM's debtor_records; the CRM was torn down 06/10/2026.)
 *
 * ── Source of truth & absolute overwrite ─────────────────────────────────────
 * Bllink is the source of truth. Its "udnp" report lists ONLY apartments with an
 * open balance, so an apartment that paid off simply DROPS OUT of the report.
 * The merge pipeline therefore zeroes every billing apartment NOT in the
 * snapshot (absent ⇒ paid ⇒ 0). Every money field is rebuilt from the snapshot
 * (default 0) and written unconditionally; `total_debt` is RECOMPUTED as
 * `management_fees + hot_water_debt`.
 *
 * ── Safety against a partial/failed download (better not to sync than to wipe
 *    real debt) ────────────────────────────────────────────────────────────────
 * Because the operation ZEROES apartments missing from the snapshot, a truncated
 * Bllink download would erase real debt. So BEFORE any write we abort (writing
 * nothing, zeroing nothing) if the run is implausibly small — below an absolute
 * floor (BLLINK_SYNC_MIN_ROWS) or below a fraction of the apartments that
 * currently owe in billing (BLLINK_SYNC_MIN_FRACTION) — or if the snapshot is
 * internally inconsistent (Σtotal ≠ Σcomponents). A clear error is recorded on
 * import_runs + sync_runs (stage 'guard') and the sync returns 409.
 *
 * ── Reconciliation AFTER the write (27/09/2026) ──────────────────────────────
 * The guards above see only the snapshot. Once importParsedRows has run, the
 * sums now in debtors — per category, over every non-archived row plus the
 * archived rows the report names — must equal the report's, and no apartment
 * may be left with a balance the report does not list, written with a different
 * amount, or missing altogether (reconcile.ts / reconcileRead.ts). A gap is
 * stage 'reconcile': the sync is an error, the banner turns red, the timer's
 * unit fails and alerts. Unlike every other stage, data HAS been written by
 * then — the message says so instead of "nothing was written".
 *
 * Freshness is the route's job (stage 'stale', before this is called): the
 * snapshot is dated by the scrape's finished_at, persisted on sync_runs as
 * source_run_at and shown on the dashboard as "the data is correct as of".
 *
 * Names/phones are NO LONGER written to debtors — those columns are frozen
 * legacy; public.contacts is the resident registry (single source of truth).
 * The mapped names / phones / emails feed ONLY the contacts hook in
 * importParsedRows (contact_sync_ingest: fills an empty field, queues a
 * conflicting one as a suggestion). Other manual/text fields (legal_status* and
 * derivatives, notes, emails, tenant_name, operator_id, phones_manual_override,
 * …) are never touched — see updateDebtorMerge in runner.ts.
 * billing.special_debt is a legacy, all-zero column not fed by Bllink; the sync
 * leaves it 0 (the zero-out keeps absent apartments at 0).
 *
 * Column mapping: src/lib/sync/bllinkMap.ts.
 */

// Safety guards (env-overridable). Defaults tuned for a ~290-unit building:
//   MIN_ROWS      — absolute floor; below this the run is treated as broken.
//   MIN_FRACTION  — the run must cover at least this fraction of the apartments
//                   that currently owe in billing (catches a half-download).
//   RECON_TOL     — allowed |Σtotal − Σcomponents| as a fraction of Σtotal.
const MIN_ROWS = Number(env.BLLINK_SYNC_MIN_ROWS ?? 50);
const MIN_FRACTION = Number(env.BLLINK_SYNC_MIN_FRACTION ?? 0.4);
const RECON_TOL = 0.01;

/** Apartments that currently carry a balance in billing — the denominator for
 *  the relative completeness guard. */
async function countBillingDebtorsWithDebt(): Promise<number> {
  const r = await query<{ c: number }>(
    `select count(*)::int as c
       from public.debtors
      where is_archived = false and total_debt > 0`,
  );
  return r.rows[0]?.c ?? 0;
}

/**
 * Runs the safety guards on an already-fetched snapshot and, if they pass,
 * OVERWRITES public.debtors with it (same merge + zero-out pipeline as a manual
 * import). A guard failure marks the import_run as error and throws a
 * SyncStageError('guard') — nothing is written or zeroed. After the write, the
 * result is reconciled against the snapshot; a gap throws
 * SyncStageError('reconcile') with the data already written. Returns the number
 * of rows written.
 *
 * Reading is separate (localPull.fetchLocalDebtorRows) so the caller can check
 * freshness BEFORE opening an import_run.
 */
export async function writeCrmSnapshot(
  rows: ParsedDebtorRow[],
  report: BllinkPullReport,
  runId: string,
): Promise<number> {
  // ── Safety reconciliation BEFORE any write (this operation zeroes every
  //    apartment absent from the snapshot, so a partial download is dangerous) ──
  const billingDebtors = await countBillingDebtorsWithDebt();
  const floor = Math.max(MIN_ROWS, Math.ceil(MIN_FRACTION * billingDebtors));
  const reconDelta = Math.abs(report.rawTotal - report.componentTotal);
  const reconOff = reconDelta > Math.max(1, RECON_TOL * report.rawTotal);

  const summary =
    `[bllink:sync] run=${runId} incoming=${report.count} billingWithDebt=${billingDebtors} ` +
    `floor=${floor} rawTotal=${report.rawTotal.toFixed(2)} componentTotal=${report.componentTotal.toFixed(2)} ` +
    `reconDelta=${reconDelta.toFixed(2)} runAt=${report.runMinAt ?? '?'}..${report.runMaxAt ?? '?'}`;

  if (report.count < floor) {
    const msg =
      `bllink_sync_aborted: current Bllink run has ${report.count} apartments, below the safety ` +
      `floor ${floor} (min ${MIN_ROWS}, ${Math.round(MIN_FRACTION * 100)}% of ${billingDebtors} current debtors). ` +
      `Suspected partial/failed download — refusing to overwrite. NOTHING was written or zeroed.`;
    logger.error(summary, '\n', msg);
    await finishRunError(runId, msg);
    throw new SyncStageError('guard', msg, report.runMaxAt);
  }

  if (reconOff) {
    const msg =
      `bllink_sync_aborted: source totals inconsistent (Σtotal=${report.rawTotal.toFixed(2)} ≠ ` +
      `Σcomponents=${report.componentTotal.toFixed(2)}, Δ=${reconDelta.toFixed(2)}). ` +
      `Refusing to overwrite. NOTHING was written or zeroed.`;
    logger.error(summary, '\n', msg);
    await finishRunError(runId, msg);
    throw new SyncStageError('guard', msg, report.runMaxAt);
  }

  logger.info(
    `${summary}\n[bllink:sync] guards passed — absolute overwrite of ${report.count} apartments + ` +
      `zero-out of every other non-archived apartment (paid off / absent from Bllink).`,
  );
  await importParsedRows(rows, 0, 'merge', runId);

  // ── Reconciliation AFTER the write: what debtors holds now vs. the snapshot ──
  // importParsedRows swallows its own errors (it marks the import_run and
  // returns), so this is also what turns a half-written merge into a failed sync.
  const after = await readDebtorsAfterWrite(getDbPool(), rows);
  const outcome = reconcileAfterWrite(snapshotTotals(rows), after);
  if (!outcome.ok) {
    logger.error(`${summary}\n[bllink:sync] reconcile FAILED — ${outcome.message}`);
    await finishRunError(runId, outcome.message);
    throw new SyncStageError('reconcile', outcome.message, report.runMaxAt);
  }
  if (outcome.warning) logger.warn(`[bllink:sync] run=${runId} ${outcome.warning}`);
  logger.info(
    `[bllink:sync] run=${runId} reconcile OK — management=${after.totals.management.toFixed(2)} ` +
      `hotWater=${after.totals.hotWater.toFixed(2)} match the snapshot; no leftovers, no mismatches.`,
  );
  return rows.length;
}

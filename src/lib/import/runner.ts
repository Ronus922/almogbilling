import 'server-only';
import { query } from '@/lib/db';
import { parseDebtorsWorkbook, type ParsedDebtorRow } from '@/lib/excel/parse';
import {
  bumpRunProgress,
  finishRunError,
  finishRunSuccess,
  setRunErrorSummary,
  setRunTotal,
  type ImportMode,
} from '@/lib/db/importRuns';
import { upsertMonthlyDebtSnapshot } from '@/lib/db/debtors';
import { ensureContactsForApartments } from '@/lib/db/contacts';
import { accrueDebtorCollection, pruneDebtorSnapshotsNotIn } from '@/lib/db/collectionTracking';
import { logger } from '@/lib/logger';

const BATCH_SIZE = 50;
const BATCH_THROTTLE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs an import end-to-end. Updates import_runs progress as it goes.
 * Errors are caught and recorded; the function never throws.
 */
export async function runImport(
  buffer: ArrayBuffer,
  mode: ImportMode,
  runId: string,
): Promise<void> {
  let parsed: { rows: ParsedDebtorRow[]; skipped: number };
  try {
    parsed = await parseDebtorsWorkbook(buffer);
  } catch (e) {
    // Parse failures (oversized / corrupt / non-.xlsx) are recorded on the run
    // row, not thrown — runImport is fire-and-forget (void) from the route.
    await finishRunError(runId, e instanceof Error ? e.message : String(e));
    return;
  }
  await importParsedRows(parsed.rows, parsed.skipped, mode, runId);
}

/**
 * Core import — shared by the Excel upload (runImport) and the Bllink pull
 * (lib/sync/bllinkPull). Applies the exact same merge/replace + zero-out rules
 * so a sync writes identical data to a manual import. Never throws; errors are
 * recorded on the import run.
 */
export async function importParsedRows(
  rows: ParsedDebtorRow[],
  skipped: number,
  mode: ImportMode,
  runId: string,
): Promise<void> {
  try {
    await setRunTotal(runId, rows.length);
    if (skipped > 0) await bumpRunProgress(runId, { skipped });

    if (mode === 'replace') {
      await query(`delete from public.debtors`);
    }

    const existingApts = mode === 'merge' ? await fetchExistingApts() : new Set<string>();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      let updated = 0;
      let created = 0;
      for (const r of batch) {
        if (mode === 'replace' || !existingApts.has(r.apartment_number)) {
          await insertDebtor(r);
          created++;
        } else {
          await updateDebtorMerge(r);
          updated++;
        }
        // Accrue this debtor's collection (drop vs its last snapshot) + advance
        // the snapshot — atomic + idempotent (see accrueDebtorCollection).
        // Best-effort: a hiccup must never fail the import; the snapshot only
        // advances when the accrual succeeds, so a skipped row is simply measured
        // on the next import — no double count, no loss.
        try {
          await accrueDebtorCollection(r.apartment_number, r.total_debt);
        } catch (accErr) {
          logger.error('[import:accrue]', runId, r.apartment_number,
            accErr instanceof Error ? accErr.message : String(accErr));
        }
      }
      await bumpRunProgress(runId, { processed: batch.length, updated, created });
      if (i + BATCH_SIZE < rows.length) {
        await sleep(BATCH_THROTTLE_MS);
      }
    }

    const importedApts = rows.map((r) => r.apartment_number);
    if (mode === 'merge') {
      await zeroOutAptsNotInImport(importedApts);
    }

    // Drop snapshots for debtors absent from this import (cleared in merge,
    // removed in replace) so a clearing/removal is never counted as collection
    // and no orphan snapshot lingers. Best-effort — never fails the import.
    try {
      await pruneDebtorSnapshotsNotIn(importedApts);
    } catch (pruneErr) {
      logger.error('[import:prune-snapshots]', runId,
        pruneErr instanceof Error ? pruneErr.message : String(pruneErr));
    }

    // Resident registry (contacts) hook — insert-missing ONLY (an existing
    // apartment is NEVER updated) + relink debtors left with contact_id NULL
    // (replace-mode recreates debtors unlinked). Best-effort — a registry
    // hiccup must never fail the import. When new apartments were created,
    // a Hebrew summary is persisted for the import UI (else stays NULL).
    try {
      const registry = await ensureContactsForApartments(rows);
      if (registry.created > 0) {
        let summary = `מרשם דיירים: נוצרו ${registry.created} דירות חדשות לבדיקה`;
        if (registry.relinked > 0) {
          summary += ` · קושרו מחדש ${registry.relinked} דירות`;
        }
        await setRunErrorSummary(runId, summary);
      }
    } catch (regErr) {
      logger.error('[import:contacts-registry]', runId,
        regErr instanceof Error ? regErr.message : String(regErr));
    }

    await finishRunSuccess(runId);

    // Capture this month's debt snapshot for the dashboard chart. Best-effort:
    // a snapshot failure must never turn a successful import into a failed run.
    try {
      await upsertMonthlyDebtSnapshot();
    } catch (snapErr) {
      const m = snapErr instanceof Error ? snapErr.message : String(snapErr);
      logger.error('[import:snapshot]', runId, m);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[import:error]', runId, msg);
    await finishRunError(runId, msg);
  }
}

async function fetchExistingApts(): Promise<Set<string>> {
  const r = await query<{ apartment_number: string }>(
    `select apartment_number from public.debtors`,
  );
  return new Set(r.rows.map((x) => x.apartment_number));
}

async function insertDebtor(r: ParsedDebtorRow): Promise<void> {
  // owner_name/phone_owner/phone_tenant are NOT written here anymore:
  // legacy — מקור האמת הוא contacts. DROP ב-Phase B
  await query(
    `insert into public.debtors
       (apartment_number,
        total_debt, management_fees, monthly_debt, hot_water_debt, details,
        last_imported_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [
      r.apartment_number,
      r.total_debt,
      r.management_fees,
      r.monthly_debt,
      r.hot_water_debt,
      r.details,
    ],
  );
}

async function updateDebtorMerge(r: ParsedDebtorRow): Promise<void> {
  // Per merge rules:
  //   - apartment_number, monthly_debt, management_fees, total_debt,
  //     hot_water_debt, details → always updated from Excel
  //   - owner_name, phone_owner, phone_tenant → NOT written here anymore;
  //     they only feed the contacts insert-missing hook.
  //     legacy — מקור האמת הוא contacts. DROP ב-Phase B
  //   - email_*, tenant_name, phones_raw, operator_id, legal_status_id,
  //     is_archived, notes, next_action_*, last_contact_date, phones_manual_override → never touched
  await query(
    `update public.debtors set
       total_debt      = $2,
       management_fees = $3,
       monthly_debt    = $4,
       hot_water_debt  = $5,
       details         = $6,
       last_imported_at = now()
     where apartment_number = $1`,
    [
      r.apartment_number,
      r.total_debt,
      r.management_fees,
      r.monthly_debt,
      r.hot_water_debt,
      r.details,
    ],
  );
}

async function zeroOutAptsNotInImport(importedApts: string[]): Promise<void> {
  if (importedApts.length === 0) {
    // No apts in import → zero out everything that's not archived
    await query(
      `update public.debtors set
         total_debt = 0,
         management_fees = 0,
         hot_water_debt = 0,
         special_debt = 0,
         monthly_debt = null
       where is_archived = false`,
    );
    return;
  }
  await query(
    `update public.debtors set
       total_debt = 0,
       management_fees = 0,
       hot_water_debt = 0,
       special_debt = 0,
       monthly_debt = null
     where is_archived = false
       and apartment_number <> all($1::text[])`,
    [importedApts],
  );
}

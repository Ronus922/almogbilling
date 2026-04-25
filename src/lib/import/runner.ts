import 'server-only';
import { query } from '@/lib/db';
import { parseDebtorsWorkbook, type ParsedDebtorRow } from '@/lib/excel/parse';
import {
  bumpRunProgress,
  finishRunError,
  finishRunSuccess,
  setRunTotal,
  type ImportMode,
} from '@/lib/db/importRuns';

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
  try {
    const { rows, skipped } = parseDebtorsWorkbook(buffer);
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
      }
      await bumpRunProgress(runId, { processed: batch.length, updated, created });
      if (i + BATCH_SIZE < rows.length) {
        await sleep(BATCH_THROTTLE_MS);
      }
    }

    if (mode === 'merge') {
      await zeroOutAptsNotInImport(rows.map((r) => r.apartment_number));
    }

    await finishRunSuccess(runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[import:error]', runId, msg);
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
  await query(
    `insert into public.debtors
       (apartment_number, owner_name, phone_owner,
        total_debt, management_fees, monthly_debt, hot_water_debt, details,
        last_imported_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      r.apartment_number,
      r.owner_name,
      r.phone_raw,
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
  //   - apartment_number, owner_name, monthly_debt, management_fees, total_debt,
  //     hot_water_debt, details → always updated from Excel
  //   - phone_owner → only updated if currently empty (coalesce keeps existing if not null/empty)
  //   - phone_tenant, email_*, tenant_name, phones_raw, operator_id, legal_status_id,
  //     is_archived, notes, next_action_*, last_contact_date, phones_manual_override → never touched
  await query(
    `update public.debtors set
       owner_name      = $2,
       phone_owner     = case when phone_owner is null or phone_owner = '' then $3 else phone_owner end,
       total_debt      = $4,
       management_fees = $5,
       monthly_debt    = $6,
       hot_water_debt  = $7,
       details         = $8,
       last_imported_at = now()
     where apartment_number = $1`,
    [
      r.apartment_number,
      r.owner_name,
      r.phone_raw,
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

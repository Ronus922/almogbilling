import 'server-only';
import { query } from '@/lib/db';

/**
 * Accrue one debtor's GROSS collection for the current month and advance its
 * debt snapshot — atomically, in a single statement.
 *
 * Contribution = max(0, prev_snapshot.total_debt − newTotalDebt): only a DROP in
 * this debtor's debt counts (a rise from new charges contributes nothing, never
 * a negative). The snapshot is upserted to newTotalDebt in the SAME statement,
 * which makes the whole thing idempotent — a re-run of the same import sees
 * prev == new → delta 0 → no double count. That per-debtor atomicity is what
 * guards accrual against a mid-import failure/retry (the import itself is not
 * transaction-wrapped). A debtor with no prior snapshot (brand new) accrues
 * nothing — only its snapshot is created.
 *
 * In the CTE, `prev` and `snap` run on the same statement snapshot, so `prev`
 * reads the OLD debt even though `snap` overwrites it. Month is anchored to
 * Asia/Jerusalem to match upsertMonthlyDebtSnapshot. Verified against the DB.
 */
export async function accrueDebtorCollection(
  apartmentNumber: string,
  newTotalDebt: number,
): Promise<void> {
  await query(
    `with prev as (
       select total_debt as old_debt
         from public.debtor_debt_snapshots
        where apartment_number = $1
     ),
     snap as (
       insert into public.debtor_debt_snapshots (apartment_number, total_debt, snapshot_at)
       values ($1, $2, now())
       on conflict (apartment_number)
       do update set total_debt = excluded.total_debt, snapshot_at = now()
     )
     insert into public.monthly_collections (year, month, collected_amount, updated_at)
     select extract(year  from (now() at time zone 'Asia/Jerusalem'))::int,
            extract(month from (now() at time zone 'Asia/Jerusalem'))::int,
            (prev.old_debt - $2), now()
       from prev
      where prev.old_debt - $2 > 0
     on conflict (year, month)
     do update set collected_amount = public.monthly_collections.collected_amount + excluded.collected_amount,
                   updated_at = now()`,
    [apartmentNumber, newTotalDebt],
  );
}

/**
 * Drop per-debtor snapshots whose apartment_number is absent from this import —
 * a debtor cleared by the merge zero-out or removed by a 'replace'. A
 * clearing/removal must NOT count as collection, so we delete the snapshot (no
 * accrual); if the apartment reappears later it is treated as brand new. An
 * empty import → every snapshot is orphaned → clear the table.
 */
export async function pruneDebtorSnapshotsNotIn(importedApts: string[]): Promise<void> {
  if (importedApts.length === 0) {
    await query(`delete from public.debtor_debt_snapshots`);
    return;
  }
  await query(
    `delete from public.debtor_debt_snapshots where apartment_number <> all($1::text[])`,
    [importedApts],
  );
}

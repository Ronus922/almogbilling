import 'server-only';
import type { Pool } from 'pg';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import type { DebtorsAfterWrite } from './reconcile';

/**
 * Reads what public.debtors holds AFTER importParsedRows wrote a Bllink
 * snapshot, in the shape reconcile.ts decides on. One round trip.
 *
 * Takes the pool explicitly (the shared one in production, a throwaway one in
 * tests/sync-reconcile-db.test.ts) so the SQL is exercised against a real
 * schema without touching production data. `pool.query` with a literal keeps
 * it under SafeQL.
 *
 * Scope = the rows the sync owns: every non-archived apartment (written if in
 * the report, zeroed if not) + every archived apartment the report names
 * (written by updateDebtorMerge, which does not filter on is_archived). An
 * archived apartment the report dropped is never zeroed by design — it is
 * listed separately as a warning, not counted against the totals.
 */
export type ReconcilePool = Pick<Pool, 'query'>;

interface AfterWriteRow {
  management: number;
  hot_water: number;
  leftovers: string[];
  mismatched: string[];
  archived_leftovers: string[];
  unwritten: string[];
}

/** The three fields of a mapped row the reconciliation needs. */
export type ReconcileRow = Pick<ParsedDebtorRow, 'apartment_number' | 'management_fees' | 'hot_water_debt'>;

export async function readDebtorsAfterWrite(
  pool: ReconcilePool,
  rows: readonly ReconcileRow[],
): Promise<DebtorsAfterWrite> {
  const apartments = rows.map((r) => r.apartment_number);
  const management = rows.map((r) => r.management_fees);
  const hotWater = rows.map((r) => r.hot_water_debt);

  const r = await pool.query<AfterWriteRow>(
    `with report as (
       select * from unnest($1::text[], $2::float8[], $3::float8[])
         as r(apartment_number, management, hot_water)
     ),
     scope as (
       select d.apartment_number, d.management_fees, d.hot_water_debt, d.total_debt, d.is_archived,
              (r.apartment_number is not null) as in_report,
              round(r.management::numeric, 2) as r_management,
              round(r.hot_water::numeric, 2)  as r_hot_water
         from public.debtors d
         left join report r on r.apartment_number = d.apartment_number
     )
     select
       coalesce(sum(management_fees) filter (where in_report or not is_archived), 0)::float8 as management,
       coalesce(sum(hot_water_debt)  filter (where in_report or not is_archived), 0)::float8 as hot_water,
       coalesce(array_agg(apartment_number order by apartment_number)
                filter (where not in_report and not is_archived and total_debt > 0), '{}'::text[]) as leftovers,
       coalesce(array_agg(apartment_number order by apartment_number)
                filter (where in_report and (management_fees <> r_management or hot_water_debt <> r_hot_water)), '{}'::text[]) as mismatched,
       coalesce(array_agg(apartment_number order by apartment_number)
                filter (where not in_report and is_archived and total_debt > 0), '{}'::text[]) as archived_leftovers,
       (select coalesce(array_agg(r.apartment_number order by r.apartment_number), '{}'::text[])
          from report r
         where not exists (select 1 from public.debtors d where d.apartment_number = r.apartment_number)) as unwritten
     from scope`,
    [apartments, management, hotWater],
  );
  const row = r.rows[0];
  if (!row) throw new Error('reconcile read returned no row');
  return {
    totals: { management: row.management, hotWater: row.hot_water },
    leftovers: row.leftovers,
    unwritten: row.unwritten,
    mismatched: row.mismatched,
    archivedLeftovers: row.archived_leftovers,
  };
}

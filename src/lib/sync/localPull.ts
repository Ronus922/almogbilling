import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { buildSnapshot, type BllinkPullReport, type SourceDebtorRecord } from './bllinkMap';

/**
 * The debtors snapshot: billing's OWN scrape of Bllink (scripts/bllink-scrape.ts
 * → public.bllink_scrapes / bllink_scrape_rows, 05:30 Asia/Jerusalem) — the only
 * source since the CRM (almog) was torn down on 06/10/2026. Read-only; the write
 * goes through bllinkPull.writeCrmSnapshot → importParsedRows. The rows are
 * stored in the CRM's old debtor_records naming, which the mapper (bllinkMap.ts)
 * still reads.
 */

export interface LocalSnapshot {
  scrapeId: string;
  /** bllink_scrapes.finished_at, ISO — the moment billing downloaded the report.
   *  Becomes sync_runs.source_run_at ("נתוני בלינק נכונים ל-"). */
  finishedAt: string;
  /** Did that scrape reach Bllink's resident list? false = its names and
   *  phones came from the debt export's labelled cells alone. Recorded for
   *  the log and for anyone reading the run afterwards; the per-row decision
   *  travels on the rows themselves (owner_name_from_list). */
  tenantListOk: boolean;
  rows: ParsedDebtorRow[];
  report: BllinkPullReport;
}

/** The newest SUCCESSFUL scrape, mapped; null when there is none yet. */
export async function fetchLocalDebtorRows(): Promise<LocalSnapshot | null> {
  const scrape = await queryOne<{ id: string; finished_at: Date; tenant_list_ok: boolean }>(
    `select id, finished_at, tenant_list_ok
       from public.bllink_scrapes
      where status = 'success' and finished_at is not null
      order by finished_at desc
      limit 1`,
  );
  if (!scrape) return null;

  const r = await query<SourceDebtorRecord>(
    `select apartment_number, owner_name, phone_primary,
            list_owner_name, list_owner_phone, list_owner_email,
            list_tenant_name, list_tenant_phone, list_tenant_email,
            total_debt::float8 as total_debt, monthly_debt::float8 as monthly_debt,
            special_debt::float8 as special_debt, management_months_raw, notes
       from public.bllink_scrape_rows
      where scrape_id = $1
      order by id`,
    [scrape.id],
  );
  const finishedAt = new Date(scrape.finished_at).toISOString();
  return {
    scrapeId: scrape.id,
    finishedAt,
    tenantListOk: scrape.tenant_list_ok,
    ...buildSnapshot(r.rows, { minAt: finishedAt, maxAt: finishedAt }),
  };
}

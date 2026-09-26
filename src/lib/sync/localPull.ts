import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import type { CompareResult, CompareRow } from './bllinkCompare';
import { buildSnapshot, type BllinkPullReport, type SourceDebtorRecord } from './bllinkMap';

/**
 * BLLINK_SOURCE=billing: the debtors snapshot comes from billing's OWN scrape of
 * Bllink (scripts/bllink-scrape.ts → public.bllink_scrapes / bllink_scrape_rows,
 * 05:30 Asia/Jerusalem) instead of the CRM's debtor_records. Read-only; the
 * write goes through exactly the same guards + runner as the CRM path
 * (bllinkPull.writeCrmSnapshot → importParsedRows). The rows are stored in the
 * CRM naming, so the shared mapper (bllinkMap.ts) applies unchanged.
 */

export interface LocalSnapshot {
  scrapeId: string;
  /** bllink_scrapes.finished_at, ISO — the moment billing downloaded the report.
   *  Becomes sync_runs.source_run_at ("נתוני בלינק נכונים ל-"). */
  finishedAt: string;
  rows: ParsedDebtorRow[];
  report: BllinkPullReport;
  compareRows: Map<string, CompareRow>;
}

/** The newest SUCCESSFUL scrape, mapped; null when there is none yet. */
export async function fetchLocalDebtorRows(): Promise<LocalSnapshot | null> {
  const scrape = await queryOne<{ id: string; finished_at: Date }>(
    `select id, finished_at
       from public.bllink_scrapes
      where status = 'success' and finished_at is not null
      order by finished_at desc
      limit 1`,
  );
  if (!scrape) return null;

  const r = await query<SourceDebtorRecord>(
    `select apartment_number, owner_name, phone_primary,
            total_debt::float8 as total_debt, monthly_debt::float8 as monthly_debt,
            special_debt::float8 as special_debt, management_months_raw, notes
       from public.bllink_scrape_rows
      where scrape_id = $1
      order by id`,
    [scrape.id],
  );
  const finishedAt = new Date(scrape.finished_at).toISOString();
  return { scrapeId: scrape.id, finishedAt, ...buildSnapshot(r.rows, { minAt: finishedAt, maxAt: finishedAt }) };
}

/** The sync's witness comparison (or its unavailability) goes onto the scrape
 *  row it copied, over the scrape's own preliminary comparison. */
export async function recordWitnessCompare(scrapeId: string, result: CompareResult): Promise<void> {
  await query(
    `update public.bllink_scrapes set compare_summary = $2::jsonb where id = $1`,
    [scrapeId, JSON.stringify(result)],
  );
}

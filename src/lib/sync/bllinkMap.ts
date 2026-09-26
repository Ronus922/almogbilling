/**
 * One Bllink report row in the CRM debtor_records naming → the ParsedDebtorRow
 * the import runner writes, the reconciliation report the guards check, and the
 * CompareRow the witness comparison reads. Pure; shared by the CRM pull
 * (bllinkPull.ts) and the local pull (localPull.ts), so BOTH sources of
 * public.debtors are mapped by literally the same code — the switch between
 * them (BLLINK_SOURCE) changes where the rows come from, never what is written.
 *
 * Column mapping (source → billing debtors / ParsedDebtorRow):
 *   apartment_number      →  apartment_number
 *   owner_name            →  owner_name (feeds the contacts insert-missing hook only)
 *   phone_primary         →  phone_owner / phone_tenant (split; contacts hook only)
 *   monthly_debt (E)      →  management_fees
 *   special_debt (G)      →  hot_water_debt
 *   management_months_raw (F) → monthly_debt (text month-range)
 *   total_debt (D)        →  reconciliation only; billing total_debt is RECOMPUTED
 *                            = management_fees + hot_water_debt
 *   notes (H)             →  details
 */
import { splitOwnerTenantPhones } from '@/lib/whatsapp';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { round2, toNum, toText, type CompareRow } from './bllinkCompare';

/** What both sources hand over: the CRM's debtor_records row (PostgREST) and
 *  a public.bllink_scrape_rows row (pg — numerics arrive as strings). */
export interface SourceDebtorRecord {
  apartment_number: string | null;
  owner_name: string | null;
  phone_primary: string | null;
  total_debt: number | string | null;
  monthly_debt: number | string | null;
  special_debt: number | string | null;
  management_months_raw: string | null;
  notes: string | null;
}

export interface BllinkPullReport {
  count: number;
  /** Σ source-reported total_debt (column D) of the snapshot. */
  rawTotal: number;
  /** Σ (management_fees + hot_water_debt) — what will actually be written. */
  componentTotal: number;
  /** When the source scraped Bllink (oldest / newest row). */
  runMinAt: string | null;
  runMaxAt: string | null;
}

export function mapSourceRow(r: SourceDebtorRecord): ParsedDebtorRow | null {
  const apt = toText(r.apartment_number);
  if (!apt) return null;
  // phone_primary may be compound/labelled ("054… (בעלים) 050… (שוכר/ת)") —
  // split into clean local owner/tenant numbers before writing.
  const phones = splitOwnerTenantPhones(r.phone_primary);
  const management_fees = toNum(r.monthly_debt);
  const hot_water_debt = toNum(r.special_debt);
  return {
    apartment_number: apt,
    owner_name: toText(r.owner_name),
    phone_owner: phones.owner,
    phone_tenant: phones.tenant,
    // Absolute overwrite: total_debt is REBUILT from the components (default 0),
    // never the raw source total — so a stale/inconsistent source total cannot
    // leak in. Reconciled against the source total before writing.
    total_debt: round2(management_fees + hot_water_debt),
    management_fees,
    monthly_debt: toText(r.management_months_raw),
    hot_water_debt,
    details: toText(r.notes),
  };
}

export function toCompareRow(r: SourceDebtorRecord): CompareRow {
  return {
    total_debt: round2(toNum(r.total_debt)),
    monthly_debt: round2(toNum(r.monthly_debt)),
    special_debt: round2(toNum(r.special_debt)),
    management_months_raw: toText(r.management_months_raw),
    notes: toText(r.notes),
  };
}

/** Trimmed apartment number → record, LAST occurrence wins (a source can hold
 *  whitespace variants that trim to the same key). Apartment-less rows are dropped. */
export function dedupeByApartment<T extends { apartment_number: string | null }>(records: readonly T[]): Map<string, T> {
  const byApt = new Map<string, T>();
  for (const r of records) {
    const apt = toText(r.apartment_number);
    if (apt) byApt.set(apt, r);
  }
  return byApt;
}

export function toCompareMap(records: readonly SourceDebtorRecord[]): Map<string, CompareRow> {
  const out = new Map<string, CompareRow>();
  for (const [apt, r] of dedupeByApartment(records)) out.set(apt, toCompareRow(r));
  return out;
}

export interface Snapshot {
  rows: ParsedDebtorRow[];
  report: BllinkPullReport;
  compareRows: Map<string, CompareRow>;
}

/** Dedupe + map + reconcile a whole snapshot. `at` dates it (the source's scrape time). */
export function buildSnapshot(
  records: readonly SourceDebtorRecord[],
  at: { minAt: string | null; maxAt: string | null },
): Snapshot {
  const byApt = dedupeByApartment(records);
  const rows: ParsedDebtorRow[] = [];
  const compareRows = new Map<string, CompareRow>();
  let rawTotal = 0;
  let componentTotal = 0;
  for (const [apt, r] of byApt) {
    const mapped = mapSourceRow(r);
    if (!mapped) continue;
    rows.push(mapped);
    compareRows.set(apt, toCompareRow(r));
    rawTotal += toNum(r.total_debt);
    componentTotal += mapped.total_debt;
  }
  return {
    rows,
    compareRows,
    report: {
      count: rows.length,
      rawTotal: round2(rawTotal),
      componentTotal: round2(componentTotal),
      runMinAt: at.minAt,
      runMaxAt: at.maxAt,
    },
  };
}

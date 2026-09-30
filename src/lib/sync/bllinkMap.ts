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
 *   list_*                →  every CONTACT field, straight through. Bllink's
 *                            resident list (tenantList.ts) is the source of
 *                            names, phones and addresses since 30/09/2026.
 *   owner_name            →  the FALLBACK for the two names — the "(בעלים)"
 *                            and "(שוכר/ת)" halves of one cell (reportNames.ts)
 *   phone_primary         →  the FALLBACK for the two phones (split)
 *   monthly_debt (E)      →  management_fees
 *   special_debt (G)      →  hot_water_debt
 *   management_months_raw (F) → monthly_debt (text month-range)
 *   total_debt (D)        →  reconciliation only; billing total_debt is RECOMPUTED
 *                            = management_fees + hot_water_debt
 *   notes (H)             →  details
 */
import { cleanPhoneField, splitOwnerTenantPhones } from '@/lib/whatsapp';
import { splitOwnerTenantNames } from './reportNames';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { round2, toNum, toText, type CompareRow } from './bllinkCompare';

/** What both sources hand over: the CRM's debtor_records row (PostgREST) and
 *  a public.bllink_scrape_rows row (pg — numerics arrive as strings). */
export interface SourceDebtorRecord {
  apartment_number: string | null;
  owner_name: string | null;
  phone_primary: string | null;
  /** Bllink's resident list, per field. All absent from the CRM's
   *  debtor_records — that source only ever had the export's two cells. */
  list_owner_name?: string | null;
  list_owner_phone?: string | null;
  list_owner_email?: string | null;
  list_tenant_name?: string | null;
  list_tenant_phone?: string | null;
  list_tenant_email?: string | null;
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
  // The export's two identity cells, kept as the FALLBACK for a sync that
  // could not read the resident list. Each holds whichever single person
  // Bllink printed, behind labels that are sometimes missing
  // ("בלכנר חנה (בעלים) אור מזוז (שוכר/ת)") — which is why they stopped being
  // the first choice on 30/09/2026: 53 of 219 apartments name no owner there.
  const phones = splitOwnerTenantPhones(r.phone_primary);
  const names = splitOwnerTenantNames(r.owner_name);
  // Bllink's resident list: one entry per person, an explicit role, nothing
  // truncated. Per FIELD, so a list that knows the owner but not the tenant
  // still contributes what it knows.
  const listOwnerName = toText(r.list_owner_name);
  const listTenantName = toText(r.list_tenant_name);
  const management_fees = toNum(r.monthly_debt);
  const hot_water_debt = toNum(r.special_debt);
  return {
    apartment_number: apt,
    owner_name: listOwnerName ?? names.owner,
    tenant_name: listTenantName ?? names.tenant,
    // Where a name came from decides whether it may ASK anything: a name off
    // the truncating export fills an empty field but raises no suggestion.
    owner_name_from_list: listOwnerName !== null,
    tenant_name_from_list: listTenantName !== null,
    phone_owner: cleanPhoneField(r.list_owner_phone) ?? phones.owner,
    phone_tenant: cleanPhoneField(r.list_tenant_phone) ?? phones.tenant,
    owner_email: toText(r.list_owner_email),
    tenant_email: toText(r.list_tenant_email),
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

import 'server-only';
import { importParsedRows } from '@/lib/import/runner';
import type { ParsedDebtorRow } from '@/lib/excel/parse';

/**
 * Pulls the freshly-synced Bllink debt data from the CRM's `debtor_records`
 * table (PostgREST) and merges it into this app's `public.debtors`.
 *
 * Background: the CRM (almog) scrapes the Bllink "udnp" report daily into its
 * own cloud Supabase. This app's dashboard reads a SEPARATE Postgres table
 * (proj_billing.debtors) that was only ever fed by manual Excel imports — so
 * the "Sync now" button (which merely re-triggered the CRM cron) never updated
 * the data the dashboard shows, and the freshness indicator stayed red.
 *
 * Column mapping is verified against live data — the CRM and this app read the
 * same Excel columns, only under different field names:
 *   CRM debtor_records        →  billing debtors (ParsedDebtorRow)
 *   apartment_number          →  apartment_number
 *   owner_name                →  owner_name
 *   phone_primary             →  phone_raw      (merge keeps existing if set)
 *   total_debt        (col D) →  total_debt
 *   monthly_debt      (col E) →  management_fees
 *   management_months (col F) →  monthly_debt   (text month-range)
 *   special_debt      (col G) →  hot_water_debt
 *   notes             (col H) →  details
 * Invariant total_debt = management_fees + hot_water_debt holds on both sides.
 */

interface CrmDebtorRecord {
  apartment_number: string | null;
  owner_name: string | null;
  phone_primary: string | null;
  total_debt: number | null;
  monthly_debt: number | null;
  management_months_raw: string | null;
  special_debt: number | null;
  notes: string | null;
}

const SELECT =
  'apartment_number,owner_name,phone_primary,total_debt,monthly_debt,management_months_raw,special_debt,notes';

function toNum(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toText(v: string | null): string | null {
  const s = (v ?? '').trim();
  return s.length === 0 ? null : s;
}

function mapRow(r: CrmDebtorRecord): ParsedDebtorRow | null {
  const apt = toText(r.apartment_number);
  if (!apt) return null;
  return {
    apartment_number: apt,
    owner_name: toText(r.owner_name),
    phone_raw: toText(r.phone_primary),
    total_debt: toNum(r.total_debt),
    management_fees: toNum(r.monthly_debt),
    monthly_debt: toText(r.management_months_raw),
    hot_water_debt: toNum(r.special_debt),
    details: toText(r.notes),
  };
}

/** Fetches and maps the CRM debtor_records. Read-only — does not write. */
export async function fetchCrmDebtorRows(): Promise<ParsedDebtorRow[]> {
  const base = process.env.CRM_DEBTORS_REST_URL;
  const key = process.env.CRM_DEBTORS_REST_KEY;
  if (!base || !key) {
    throw new Error('CRM_DEBTORS_REST_URL or CRM_DEBTORS_REST_KEY not configured');
  }

  const url = `${base.replace(/\/$/, '')}?select=${SELECT}&limit=10000`;
  const res = await fetch(url, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`CRM debtor_records fetch failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as CrmDebtorRecord[];
  if (!Array.isArray(data)) {
    throw new Error('CRM debtor_records returned non-array payload');
  }

  // The CRM source can hold near-duplicate apartment numbers (whitespace
  // variants that trim to the same key). Dedupe by apartment_number — last
  // occurrence wins — so the merge import never hits a unique-key conflict.
  const byApt = new Map<string, ParsedDebtorRow>();
  for (const r of data) {
    const mapped = mapRow(r);
    if (mapped) byApt.set(mapped.apartment_number, mapped);
  }
  return [...byApt.values()];
}

/**
 * Pulls fresh CRM data and merges it into public.debtors using the exact same
 * pipeline as a manual Excel import (sets last_imported_at = now(), so the
 * dashboard freshness indicator resets). Returns the number of rows merged.
 */
export async function syncDebtorsFromCrm(runId: string): Promise<number> {
  const rows = await fetchCrmDebtorRows();
  await importParsedRows(rows, 0, 'merge', runId);
  return rows.length;
}

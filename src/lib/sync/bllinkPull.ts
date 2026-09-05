import 'server-only';
import { query } from '@/lib/db';
import { importParsedRows } from '@/lib/import/runner';
import { finishRunError } from '@/lib/db/importRuns';
import { splitOwnerTenantPhones } from '@/lib/whatsapp';
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { logger } from '@/lib/logger';
import { env } from '@/env';

/**
 * Pulls the current Bllink debt report from the CRM's `debtor_records`
 * (PostgREST) and OVERWRITES this app's public.debtors with it.
 *
 * ── Source of truth & absolute overwrite ─────────────────────────────────────
 * Bllink is the source of truth. The CRM (almog) scrapes Bllink's "udnp" report
 * and upserts every apartment THAT CURRENTLY OWES into debtor_records, marking
 * the rows of the latest scrape with `imported_this_run = true` (the flag is
 * RESET each run — all true rows share that run's `last_import_at`). Bllink's
 * report lists ONLY apartments with an open balance, so an apartment that paid
 * off simply DROPS OUT of the report.
 *
 * CRITICAL bug this fixes: the CRM does NOT zero apartments that vanish from
 * Bllink — it keeps their last-known amounts as a STALE row
 * (`imported_this_run = false`). Pulling ALL CRM rows therefore copied stale
 * debt back (verified: apt 1035 paid hot water, dropped from Bllink, yet the CRM
 * still held special_debt = 261, so billing showed hot_water_debt = 261 forever).
 * The fix: pull ONLY the current run (`imported_this_run = true`) — the
 * authoritative, COMPLETE Bllink snapshot — and let the merge pipeline zero
 * every billing apartment NOT in it (absent ⇒ paid ⇒ 0). Every money field is
 * rebuilt from the response (default 0) and written unconditionally;
 * `total_debt` is RECOMPUTED as `management_fees + hot_water_debt`.
 *
 * ── Safety against a partial/failed download (better not to sync than to wipe
 *    real debt) ────────────────────────────────────────────────────────────────
 * Because the operation ZEROES apartments missing from the response, a truncated
 * Bllink download would erase real debt. So BEFORE any write we abort (writing
 * nothing, zeroing nothing) if the run is implausibly small — below an absolute
 * floor (BLLINK_SYNC_MIN_ROWS) or below a fraction of the apartments that
 * currently owe in billing (BLLINK_SYNC_MIN_FRACTION) — or if the response is
 * internally inconsistent (Σtotal ≠ Σcomponents). A clear error is recorded and
 * the sync returns 502.
 *
 * Names/phones are NO LONGER written to debtors — those columns are frozen
 * legacy; public.contacts is the resident registry (single source of truth).
 * The mapped owner_name / phone_owner / phone_tenant values feed ONLY the
 * contacts insert-missing hook in importParsedRows (INSERT … ON CONFLICT DO
 * NOTHING — an existing apartment's contact is never updated). Other
 * manual/text fields (legal_status* and derivatives, notes, emails,
 * tenant_name, operator_id, phones_manual_override, …) are never touched —
 * see updateDebtorMerge in runner.ts. billing.special_debt is a legacy,
 * all-zero column not fed by Bllink; the sync leaves it 0 (the zero-out keeps
 * absent apartments at 0).
 *
 * Column mapping (CRM debtor_records → billing debtors / ParsedDebtorRow):
 *   apartment_number  →  apartment_number
 *   owner_name        →  owner_name (feeds the contacts hook only)
 *   phone_primary     →  phone_owner / phone_tenant (split; contacts hook only)
 *   monthly_debt (E)  →  management_fees
 *   special_debt (G)  →  hot_water_debt
 *   management_months_raw (F) → monthly_debt (text month-range)
 *   total_debt   (D)  →  reconciliation only; billing total_debt is RECOMPUTED
 *                         = management_fees + hot_water_debt
 *   notes        (H)  →  details
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
  imported_this_run: boolean | null;
  last_import_at: string | null;
}

const SELECT =
  'apartment_number,owner_name,phone_primary,total_debt,monthly_debt,management_months_raw,special_debt,notes,imported_this_run,last_import_at';

// Safety guards (env-overridable). Defaults tuned for a ~290-unit building:
//   MIN_ROWS      — absolute floor; below this the run is treated as broken.
//   MIN_FRACTION  — the run must cover at least this fraction of the apartments
//                   that currently owe in billing (catches a half-download).
//   RECON_TOL     — allowed |Σtotal − Σcomponents| as a fraction of Σtotal.
const MIN_ROWS = Number(env.BLLINK_SYNC_MIN_ROWS ?? 50);
const MIN_FRACTION = Number(env.BLLINK_SYNC_MIN_FRACTION ?? 0.4);
const RECON_TOL = 0.01;

function toNum(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toText(v: string | null): string | null {
  const s = (v ?? '').trim();
  return s.length === 0 ? null : s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mapRow(r: CrmDebtorRecord): ParsedDebtorRow | null {
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

export interface BllinkPullReport {
  count: number;
  rawTotal: number; // Σ CRM-reported total_debt (current run)
  componentTotal: number; // Σ (management_fees + hot_water_debt)
  runMinAt: string | null;
  runMaxAt: string | null;
}

/**
 * Fetches + maps ONLY the current Bllink run (`imported_this_run = true`).
 * Read-only — does not write. Returns the mapped rows plus a reconciliation
 * report used by the safety guards in syncDebtorsFromCrm.
 */
export async function fetchCrmDebtorRows(): Promise<{ rows: ParsedDebtorRow[]; report: BllinkPullReport }> {
  const base = env.CRM_DEBTORS_REST_URL;
  const key = env.CRM_DEBTORS_REST_KEY;
  if (!base || !key) {
    throw new Error('CRM_DEBTORS_REST_URL or CRM_DEBTORS_REST_KEY not configured');
  }

  // Only the current Bllink report — apartments that dropped out (paid off) are
  // `imported_this_run = false` and are intentionally EXCLUDED so the merge
  // zero-out resets them in billing.
  const url = `${base.replace(/\/$/, '')}?select=${SELECT}&imported_this_run=eq.true&limit=10000`;
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
  // variants that trim to the same key). Dedupe the RAW records by
  // apartment_number — last occurrence wins — then map + reconcile.
  const rawByApt = new Map<string, CrmDebtorRecord>();
  for (const r of data) {
    const apt = toText(r.apartment_number);
    if (apt) rawByApt.set(apt, r);
  }

  const rows: ParsedDebtorRow[] = [];
  let rawTotal = 0;
  let componentTotal = 0;
  let runMinAt: string | null = null;
  let runMaxAt: string | null = null;
  for (const r of rawByApt.values()) {
    const mapped = mapRow(r);
    if (!mapped) continue;
    rows.push(mapped);
    rawTotal += toNum(r.total_debt);
    componentTotal += mapped.total_debt;
    const at = r.last_import_at;
    if (at) {
      if (runMinAt === null || at < runMinAt) runMinAt = at;
      if (runMaxAt === null || at > runMaxAt) runMaxAt = at;
    }
  }

  return {
    rows,
    report: {
      count: rows.length,
      rawTotal: round2(rawTotal),
      componentTotal: round2(componentTotal),
      runMinAt,
      runMaxAt,
    },
  };
}

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
 * Pulls the current Bllink run and OVERWRITES public.debtors with it (same merge
 * + zero-out pipeline as a manual import). Aborts — writing nothing — if the run
 * fails the completeness/reconciliation guards. Returns the number of rows
 * written.
 */
export async function syncDebtorsFromCrm(runId: string): Promise<number> {
  const { rows, report } = await fetchCrmDebtorRows();

  // ── Safety reconciliation BEFORE any write (this operation zeroes every
  //    apartment absent from the response, so a partial download is dangerous) ──
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
    throw new Error(msg);
  }

  if (reconOff) {
    const msg =
      `bllink_sync_aborted: source totals inconsistent (Σtotal=${report.rawTotal.toFixed(2)} ≠ ` +
      `Σcomponents=${report.componentTotal.toFixed(2)}, Δ=${reconDelta.toFixed(2)}). ` +
      `Refusing to overwrite. NOTHING was written or zeroed.`;
    logger.error(summary, '\n', msg);
    await finishRunError(runId, msg);
    throw new Error(msg);
  }

  logger.info(
    `${summary}\n[bllink:sync] guards passed — absolute overwrite of ${report.count} apartments + ` +
      `zero-out of every other non-archived apartment (paid off / absent from Bllink).`,
  );
  await importParsedRows(rows, 0, 'merge', runId);
  return rows.length;
}

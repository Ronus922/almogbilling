/**
 * The apartment-by-apartment comparison of two Bllink snapshots, in the CRM
 * debtor_records naming (D total_debt · E monthly_debt · F management_months_raw ·
 * G special_debt · H notes). Pure — no DB, no env, no 'server-only' — so it is
 * shared by the scraper (scripts/bllink-scrape.ts, which compares its own
 * download with what the CRM holds) and by /api/sync/bllink in
 * BLLINK_SOURCE=billing mode, which writes debtors from the local snapshot and
 * then asks the CRM for the same morning's report as a WITNESS. Tested in
 * tests/sync-compare.test.ts.
 */

export const COMPARE_FIELDS = ['total_debt', 'monthly_debt', 'special_debt', 'management_months_raw', 'notes'] as const;
export type CompareField = (typeof COMPARE_FIELDS)[number];

/** Money differences below this are rounding, not a difference. */
export const MONEY_TOLERANCE = 0.005;

export interface CompareRow {
  total_debt: number;
  monthly_debt: number;
  special_debt: number;
  management_months_raw: string | null;
  notes: string | null;
}

export interface Diff {
  apt: string;
  field: CompareField;
  crm: number | string | null;
  local: number | string | null;
}

/**
 * Who produced the comparison: the 05:30 scrape (against whatever the CRM held
 * at that moment — usually yesterday's report) or the 06:00 sync (against the
 * CRM's fresh report of the same morning — the definitive one, written over the
 * scrape's on the same bllink_scrapes row).
 */
export type ComparedBy = 'scrape' | 'sync';

export interface CompareSummary {
  crm_rows: number;
  local_rows: number;
  /** Newest last_import_at of the CRM run — when the CRM actually scraped Bllink. */
  crm_snapshot_at: string | null;
  /** Apartments in the CRM snapshot that the local one lacks. */
  missing: string[];
  /** Apartments in the local snapshot that the CRM lacks. */
  extra: string[];
  diffs: Diff[];
  /** missing + extra + diffs — 0 means the two snapshots agree. */
  diff_count: number;
  /** Header-less / apartment-less rows the parser dropped (scrape only). */
  parse_skipped: number;
  compared_by: ComparedBy;
  compared_at: string;
}

/**
 * The CRM could not be asked (BLLINK_SOURCE=billing only). Stored in place of
 * the summary as a WARNING — the CRM is not on the data path, so its absence is
 * never a failed scrape or a failed sync, and never an alert.
 */
export interface CompareUnavailable {
  compare: 'unavailable';
  reason: string;
  local_rows: number;
  compared_by: ComparedBy;
  compared_at: string;
}

export type CompareResult = CompareSummary | CompareUnavailable;

export function isCompareUnavailable(r: CompareResult | null | undefined): r is CompareUnavailable {
  return !!r && 'compare' in r && r.compare === 'unavailable';
}

export function toText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

/** A finite number, or 0. Accepts the string pg returns for `numeric`. */
export function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function sameValue(field: CompareField, a: number | string | null, b: number | string | null): boolean {
  if (field === 'management_months_raw' || field === 'notes') {
    return (toText(a) ?? '') === (toText(b) ?? '');
  }
  return Math.abs(toNum(a) - toNum(b)) < MONEY_TOLERANCE;
}

export function compareSnapshots(
  local: ReadonlyMap<string, CompareRow>,
  crm: ReadonlyMap<string, CompareRow>,
  opts: { crmSnapshotAt: string | null; comparedBy: ComparedBy; parseSkipped?: number; now?: Date },
): CompareSummary {
  const missing = [...crm.keys()].filter((apt) => !local.has(apt)).sort();
  const extra = [...local.keys()].filter((apt) => !crm.has(apt)).sort();

  const diffs: Diff[] = [];
  for (const [apt, l] of local) {
    const c = crm.get(apt);
    if (!c) continue;
    for (const field of COMPARE_FIELDS) {
      if (!sameValue(field, c[field], l[field])) diffs.push({ apt, field, crm: c[field], local: l[field] });
    }
  }

  return {
    crm_rows: crm.size,
    local_rows: local.size,
    crm_snapshot_at: opts.crmSnapshotAt,
    missing,
    extra,
    diffs,
    diff_count: missing.length + extra.length + diffs.length,
    parse_skipped: opts.parseSkipped ?? 0,
    compared_by: opts.comparedBy,
    compared_at: (opts.now ?? new Date()).toISOString(),
  };
}

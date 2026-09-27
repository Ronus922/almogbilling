/**
 * Post-write reconciliation of the Bllink sync — pure, no DB, no env, no
 * 'server-only', so it is unit-tested in isolation (tests/sync-reconcile.test.ts).
 *
 * The guards in bllinkPull.ts look at the SNAPSHOT before anything is written
 * (row count, Σtotal vs Σcomponents). They cannot see public.debtors, so a
 * write that did not land — an apartment that paid, dropped out of the report
 * and was NOT zeroed; a row the merge failed to update; an insert that never
 * happened — still ended as a `success` sync (27/09/2026: three paid apartments
 * kept 13,059 ₪ of debt on the dashboard through seven "successful" syncs).
 *
 * This module compares what is in debtors AFTER the write with the report that
 * was just copied, per category (management fees / hot water). The actual side
 * is read over the rows the sync OWNS — every non-archived apartment plus every
 * archived one the report names — because that is exactly the set
 * importParsedRows writes or zeroes (zeroOutAptsNotInImport skips archived
 * rows). Sums alone can cancel out (+100 here, −100 there), so the per-apartment
 * lists decide too. Any difference = stage 'reconcile', the run is an error and
 * the dashboard banner turns red.
 */
import type { ParsedDebtorRow } from '@/lib/excel/parse';
import { round2 } from './bllinkCompare';

export interface CategoryTotals {
  /** Σ management_fees (Bllink column E). */
  management: number;
  /** Σ hot_water_debt (Bllink column G). */
  hotWater: number;
}

/** What public.debtors holds right after the merge (see reconcileRead.ts). */
export interface DebtorsAfterWrite {
  /** Σ over the sync's write scope: every non-archived row + every archived row the report names. */
  totals: CategoryTotals;
  /** Non-archived apartments with a balance that the report does not list — the zero-out missed them. */
  leftovers: string[];
  /** Report apartments with no debtors row at all — the insert did not happen. */
  unwritten: string[];
  /** Report apartments whose debtors amounts differ from the report — the update did not land. */
  mismatched: string[];
  /** Archived apartments with a balance the report no longer lists. Outside the
   *  write scope by design (archived rows are never zeroed) — reported as a
   *  warning, never a failure. */
  archivedLeftovers: string[];
}

export type ReconcileOutcome =
  | { ok: true; warning: string | null }
  | { ok: false; message: string };

/** Per-category sums of the mapped snapshot — what the merge was asked to write. */
export function snapshotTotals(
  rows: readonly Pick<ParsedDebtorRow, 'management_fees' | 'hot_water_debt'>[],
): CategoryTotals {
  let management = 0;
  let hotWater = 0;
  for (const r of rows) {
    management += r.management_fees;
    hotWater += r.hot_water_debt;
  }
  return { management: round2(management), hotWater: round2(hotWater) };
}

const ILS = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAX_LISTED = 10;

function ils(n: number): string {
  return `${ILS.format(round2(n))} ₪`;
}

/** "1421, 737, 1608" — capped, so a broken zero-out over 200 rows stays readable. */
export function listApartments(apts: readonly string[]): string {
  const shown = apts.slice(0, MAX_LISTED).join(', ');
  return apts.length > MAX_LISTED ? `${shown} ועוד ${apts.length - MAX_LISTED}` : shown;
}

function categoryLine(label: string, expected: number, actual: number): string {
  const e = round2(expected);
  const a = round2(actual);
  if (e === a) return `${label}: ${ils(e)} (תואם)`;
  return `${label}: דוח ${ils(e)}, נכתב ${ils(a)} (פער ${ils(Math.abs(a - e))})`;
}

/**
 * Decides whether the write reconciles with the report. Both sums are rounded
 * to agorot before comparing — the same round2 both writers use — so float
 * noise cannot fail a run, and a single agora of real difference does.
 */
export function reconcileAfterWrite(expected: CategoryTotals, actual: DebtorsAfterWrite): ReconcileOutcome {
  const managementOff = round2(expected.management) !== round2(actual.totals.management);
  const hotWaterOff = round2(expected.hotWater) !== round2(actual.totals.hotWater);
  const listsOff = actual.leftovers.length > 0 || actual.unwritten.length > 0 || actual.mismatched.length > 0;

  const warning =
    actual.archivedLeftovers.length > 0
      ? `דירות מאורכבות עם חוב שאינן בדוח בלינק (לא אופסו — מחוץ לתחום הסנכרון) (${actual.archivedLeftovers.length}): ${listApartments(actual.archivedLeftovers)}`
      : null;

  if (!managementOff && !hotWaterOff && !listsOff) {
    return { ok: true, warning };
  }

  const parts: string[] = [
    'הסכומים ב-debtors אחרי הכתיבה אינם תואמים לדוח בלינק.',
    categoryLine('דמי ניהול', expected.management, actual.totals.management),
    categoryLine('מים חמים', expected.hotWater, actual.totals.hotWater),
  ];
  if (actual.leftovers.length > 0) {
    parts.push(`דירות עם חוב שאינן בדוח ולא אופסו (${actual.leftovers.length}): ${listApartments(actual.leftovers)}.`);
  }
  if (actual.mismatched.length > 0) {
    parts.push(`דירות מהדוח שנכתבו בסכום שונה (${actual.mismatched.length}): ${listApartments(actual.mismatched)}.`);
  }
  if (actual.unwritten.length > 0) {
    parts.push(`דירות מהדוח שחסרות ב-debtors (${actual.unwritten.length}): ${listApartments(actual.unwritten)}.`);
  }
  parts.push('הכתיבה בוצעה — נתוני החוב על המסך עשויים להיות שגויים עד לסנכרון מוצלח.');
  return { ok: false, message: parts.join(' ') };
}

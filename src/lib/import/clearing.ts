import type { Pool } from 'pg';

/** Just the `query` of a pg Pool — the shared pool in production, a throwaway
 *  one in tests/import-clearing-db.test.ts, so the SQL is exercised against a
 *  real schema without touching production data (same shape as ReconcilePool). */
export type ClearingPool = Pick<Pool, 'query'>;

/**
 * Merge mode, after every row of the import has been written: an apartment the
 * import did NOT bring is settled as far as the source is concerned, so EVERY
 * field the import owns is cleared — the four amounts and the two free-text
 * fields that describe the very debt that is gone:
 *   monthly_debt — Excel column F / Bllink `management_months_raw`: "1/26 - 9/26"
 *   details      — Excel column H / Bllink `notes`: "מים חמים 05-06/25, …"
 *
 * `details` was left behind until 29/09/2026, and that was a real bug: 1421
 * settled its debt, dropped out of the 28/09 report, its amounts went to 0 —
 * and the old "פרטים" line stayed on the tenant panel, on the print sheet and
 * in the owner's own portal, next to a ₪0 balance. 59 apartments were in that
 * state; migration 20260929… cleared them once.
 *
 * Manual fields are never touched: phone_*, email_*, tenant_name, operator_id,
 * legal_status_*, notes, next_action_*, last_contact_date, phones_manual_override.
 *
 * ARCHIVED rows are out of scope by design — the sync has never zeroed them
 * (Ronen's decision 27/09/2026: by hand, never automatically). The
 * reconciliation lists them separately as a warning.
 *
 * One statement, so the field list is written once: `x <> all('{}')` is TRUE for
 * every x, so an import with no apartments at all clears every non-archived row
 * — exactly what the second branch used to do on its own.
 */
export async function clearDebtorsNotInImport(
  pool: ClearingPool,
  importedApts: readonly string[],
): Promise<void> {
  await pool.query(
    `update public.debtors set
       total_debt = 0,
       management_fees = 0,
       hot_water_debt = 0,
       special_debt = 0,
       monthly_debt = null,
       details = null
     where is_archived = false
       and apartment_number <> all($1::text[])`,
    [importedApts],
  );
}

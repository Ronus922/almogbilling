import { visibleImportText } from '@/lib/debtor-import-text';

/**
 * "חודשים שלא שולמו" per debt type for the debtors Excel export (08/10/2026).
 *
 * Both values are DERIVED from the two Bllink text fields a debtors row already
 * carries — nothing is scraped, synced or stored for them:
 *
 *   details       Bllink column H ("פרטים" on the tenant panel). One item per
 *                 hot-water charge, comma-separated, each labelled "מים חמים":
 *                 "מים חמים 01-02/26", "מים חמים לתקופה 07-08/25",
 *                 "מים חמים 5-6/26 הערכה". Audited on all 218 open debts
 *                 (08/10/2026): EVERY item is a hot-water item (371/371) and
 *                 management fees are never listed here.
 *   monthly_debt  Bllink column F (bllink_scrape_rows.management_months_raw,
 *                 "חודשי פיגור" on the panel): the months the MANAGEMENT FEE is
 *                 owed for — a range "4/26 - 10/26", one month "10/26", or a
 *                 space-separated list "1/25 9/26 10/26". Present for exactly
 *                 the rows with management_fees > 0 (128/128, 0 mismatches).
 *
 * Hence the rule: hot water = the periods of the "מים חמים" items of `details`;
 * management fees = `monthly_debt` as Bllink states it (a range stays a range —
 * it is not expanded into months). Both go through the same ₪0 gate as the
 * card (visibleImportText): with no debt the texts describe nothing.
 */
export interface UnpaidMonthsByType {
  /** Hot-water periods, comma-separated: "01-02/26, 03-04/26". '' when none. */
  hotWater: string;
  /** Management-fee months as Bllink states them: "4/26 - 10/26". '' when none. */
  managementFees: string;
}

/** An item of `details` is a hot-water item when it is LABELLED as one. The
 *  label is stripped; a qualifier after the period ("הערכה") is kept. */
const HOT_WATER_LABEL = /^מים חמים(?:\s+לתקופה)?\s*/;

const MONTH = String.raw`\d{1,2}/\d{2,4}`;
/** Two months with only whitespace between them (no dash → not a range). */
const MONTH_LIST_GAP = new RegExp(`(${MONTH})\\s+(?=${MONTH})`, 'g');

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function unpaidMonthsByType(d: {
  details: string | null | undefined;
  monthly_debt: string | null | undefined;
  total_debt: number | null | undefined;
}): UnpaidMonthsByType {
  const details = visibleImportText(d.details, d.total_debt);
  const monthly = visibleImportText(d.monthly_debt, d.total_debt);

  const hotWater = (details ?? '')
    .split(',')
    .map(squash)
    .filter((item) => HOT_WATER_LABEL.test(item))
    .map((item) => item.replace(HOT_WATER_LABEL, ''))
    .filter((period) => period.length > 0)
    .join(', ');

  // "1/25 9/26 10/26" → "1/25, 9/26, 10/26"; "9/26 - 10/26" is left alone.
  const managementFees = monthly ? squash(monthly).replace(MONTH_LIST_GAP, '$1, ') : '';

  return { hotWater, managementFees };
}

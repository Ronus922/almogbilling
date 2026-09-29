/**
 * The two free-text fields of a debtors row that the import owns — `details`
 * ("פרטים", Excel column H / Bllink notes) and `monthly_debt` ("חודשי פיגור" on
 * the tenant panel, "חיוב חודשי" in the portal; column F, a month range) — both
 * describe the debt itself. With no debt they describe nothing.
 *
 * The source of truth is the clearing in lib/import/clearing.ts: an apartment
 * that leaves the Bllink report has both cleared, and migration 20260929… did
 * it once for the 59 rows settled before that fix. This is the last line of
 * defence, for text that still arrives WITH a zero balance — only reachable
 * from a manual Excel import, since Bllink never reports a settled apartment
 * (0 such rows in all 23 retained scrapes, 29/09/2026). Nothing is written:
 * the row keeps whatever the source sent, the screen just does not show a debt
 * description next to a ₪0 balance.
 *
 * Used by every surface that renders the card: the tenant panel
 * (AdditionalInfoCard), the print sheet, and the owners portal (toAccount).
 */
export function visibleImportText(
  text: string | null | undefined,
  totalDebt: number | null | undefined,
): string | null {
  if (text == null || text.trim().length === 0) return null;
  return (totalDebt ?? 0) > 0 ? text : null;
}

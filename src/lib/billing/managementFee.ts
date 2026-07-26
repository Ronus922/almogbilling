// Management-fee formula — ONE definition, shared by the apartment card (live
// preview), the contacts API (authoritative value on save) and the settings
// route (bulk recompute when the rate changes).
//
//   דמי ניהול = גודל הדירה במ"ר × 150% × מחיר דמי ניהול למ"ר (הגדרות)
//
// Pure (no DB, no server-only) so the client may import it too.

/** The 150% factor applied on top of the per-m² rate. */
export const MANAGEMENT_FEE_MULTIPLIER = 1.5;

/**
 * Compute the monthly management fee, rounded to agorot. Returns null when
 * either input is missing/invalid — the caller then leaves the field alone
 * (no size on the apartment, or no rate configured in settings).
 */
export function computeManagementFee(
  sizeSqm: number | null | undefined,
  ratePerSqm: number | null | undefined,
): number | null {
  if (sizeSqm === null || sizeSqm === undefined || !Number.isFinite(sizeSqm) || sizeSqm < 0) return null;
  if (ratePerSqm === null || ratePerSqm === undefined || !Number.isFinite(ratePerSqm) || ratePerSqm < 0) return null;
  return Math.round(sizeSqm * MANAGEMENT_FEE_MULTIPLIER * ratePerSqm * 100) / 100;
}

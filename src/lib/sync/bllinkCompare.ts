/**
 * Value helpers for a Bllink snapshot row (text / pg numeric / money), shared by
 * the mapper (bllinkMap.ts) and the scraper (scripts/bllink-scrape.ts). Pure.
 *
 * The file is named after what it held until 06/10/2026: the apartment-by-
 * apartment comparison of billing's scrape with the CRM's snapshot. The CRM
 * (almog) was torn down that day and the comparison went with it.
 */

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

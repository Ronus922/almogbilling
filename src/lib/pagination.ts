// Pure paging arithmetic, shared by the server (page → limit/offset), the shared
// <Pagination> control and the tests. No React, no server-only imports.

// Far beyond any real log (50 rows × 100 000 pages), and low enough that page × size can
// never overflow the bigint Postgres reads OFFSET as.
const MAX_PAGE = 100_000;

/** A `page` query value → a page number in 1…MAX_PAGE. Anything that is not a positive integer is page 1. */
export function parsePage(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

export function pageCount(total: number, pageSize: number): number {
  return total > 0 ? Math.ceil(total / pageSize) : 0;
}

/** The 1-based, inclusive range a page shows — "51–100" of 398. An empty result is 0–0. */
export function pageRange(page: number, pageSize: number, total: number): { from: number; to: number } {
  if (total <= 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from: Math.min(from, total), to: Math.min(page * pageSize, total) };
}

export type PageSlot = number | 'gap-start' | 'gap-end';

/**
 * The numbered buttons. Up to 7 pages show every number; more show exactly 7 slots —
 * the first and last page always, and a gap marker where pages are skipped:
 *   current near the start   1 2 3 4 5 … 20
 *   current in the middle    1 … 9 10 11 … 20
 *   current near the end     1 … 16 17 18 19 20
 * A constant slot count keeps the control from changing width as the page moves.
 * The two gap markers differ only so React keys stay unique.
 */
export function pageWindow(page: number, count: number): PageSlot[] {
  if (count <= 0) return [];
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const current = Math.min(Math.max(page, 1), count);
  if (current <= 4) return [1, 2, 3, 4, 5, 'gap-end', count];
  if (current >= count - 3) return [1, 'gap-start', count - 4, count - 3, count - 2, count - 1, count];
  return [1, 'gap-start', current - 1, current, current + 1, 'gap-end', count];
}

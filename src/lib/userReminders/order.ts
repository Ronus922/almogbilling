// The reminders list's per-user order, as the page computes it between a drop
// and the server's answer (06/10/2026). Pure — the routes and the DB layer
// hold the same rule in SQL (lib/db/userReminders.ts: position asc nulls
// last, remind_at asc, id asc).

export interface Orderable {
  id: string;
  remind_at: string;
  position: number | null;
}

/** The list's sort: the placed ones first by position, the rest by remind_at,
 *  the id last so equal times never flicker. */
export function compareReminders(a: Orderable, b: Orderable): number {
  if (a.position !== null || b.position !== null) {
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    if (a.position !== b.position) return a.position - b.position;
  }
  const t = Date.parse(a.remind_at) - Date.parse(b.remind_at);
  if (t !== 0 && !Number.isNaN(t)) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The tab's ids after a drop, top to bottom: `dragId` taken out and put back
 * directly above `beforeId`, or — dropped at the bottom (`beforeId` null) —
 * right after the last card the user could see, `lastVisibleId` (a category
 * filter may hide part of the tab; the hidden cards keep their places). Both
 * missing = the end of the tab. The input is the FULL tab, filtered or not.
 */
export function reorderIds(
  tabIds: readonly string[],
  dragId: string,
  beforeId: string | null,
  lastVisibleId: string | null,
): string[] {
  const rest = tabIds.filter((id) => id !== dragId);
  let at = rest.length;
  if (beforeId !== null && beforeId !== dragId) {
    const i = rest.indexOf(beforeId);
    if (i !== -1) at = i;
  } else if (lastVisibleId !== null && lastVisibleId !== dragId) {
    const i = rest.indexOf(lastVisibleId);
    if (i !== -1) at = i + 1;
  }
  return [...rest.slice(0, at), dragId, ...rest.slice(at)];
}

/** The list with the new positions of one tab applied (0..n-1 for `tabIds`,
 *  everything else untouched), sorted as the server would sort it. */
export function applyOrder<T extends Orderable>(items: readonly T[], tabIds: readonly string[]): T[] {
  const pos = new Map(tabIds.map((id, i) => [id, i]));
  return items
    .map((r) => (pos.has(r.id) ? { ...r, position: pos.get(r.id)! } : r))
    .sort(compareReminders);
}

import type { WorkItem } from '@/lib/types/workItems';

// Default employee-lane order for the board (13/10/2026, decision 3) when the
// viewer never customized it ("התאמת לוח"): only employees with an open item
// in the viewer's OWN scoped `items` — not the full roster — busiest first,
// then alphabetical (Hebrew collation, the same tie-break every other list in
// this module uses) as the tie break. Pure and exported on its own so it can
// be tested without rendering WorkEntityScreen.
export function defaultBoardLaneOrder(
  items: WorkItem[],
  employees: { id: string; name: string }[],
): string[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.status_v2 === 'closed' || i.assignee?.kind !== 'user') continue;
    counts.set(i.assignee.id, (counts.get(i.assignee.id) ?? 0) + 1);
  }
  return employees
    .filter((e) => (counts.get(e.id) ?? 0) > 0)
    .sort((a, b) => (counts.get(b.id)! - counts.get(a.id)!) || a.name.localeCompare(b.name, 'he'))
    .map((e) => e.id);
}

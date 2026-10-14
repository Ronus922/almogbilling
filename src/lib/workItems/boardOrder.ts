import { SUPPLIERS_LANE_ID } from '@/lib/constants/workItems';
import type { WorkItem } from '@/lib/types/workItems';

// Default lane order for the board (13/10/2026, decision 3; extended
// 14/10/2026, decision 3 of "התאמת לוח — ספקים + בחירה מפורשת גוברת", to
// treat the combined "ספקים" lane the same way) when the viewer never
// customized it ("התאמת לוח"): employee lanes are only employees with an
// open item in the viewer's OWN scoped `items` — not the full roster —
// busiest first, then alphabetical (Hebrew collation, the same tie-break
// every other list in this module uses). The suppliers lane follows the same
// "open item in scope" rule but is never part of that sort — like the
// reference board, it is always the last lane when it appears at all
// (SUPPLIERS_LANE_ID appended at the end). Pure and exported on its own so it
// can be tested without rendering WorkEntityScreen.
export function defaultBoardLaneOrder(
  items: WorkItem[],
  employees: { id: string; name: string }[],
): string[] {
  const counts = new Map<string, number>();
  let hasOpenSupplierItem = false;
  for (const i of items) {
    if (i.status_v2 === 'closed') continue;
    if (i.assignee?.kind === 'user') {
      counts.set(i.assignee.id, (counts.get(i.assignee.id) ?? 0) + 1);
    } else if (i.assignee?.kind === 'supplier') {
      hasOpenSupplierItem = true;
    }
  }
  const employeeIds = employees
    .filter((e) => (counts.get(e.id) ?? 0) > 0)
    .sort((a, b) => (counts.get(b.id)! - counts.get(a.id)!) || a.name.localeCompare(b.name, 'he'))
    .map((e) => e.id);
  return hasOpenSupplierItem ? [...employeeIds, SUPPLIERS_LANE_ID] : employeeIds;
}

// The board's effective lane order (14/10/2026, "התאמת לוח — ספקים + בחירה
// מפורשת גוברת", decision 1 — explicit selection wins, for every lane,
// employee or suppliers alike): no saved row at all (`savedOrder === null`)
// → the default algorithm decides every lane, employees and suppliers both,
// purely from current open items. A saved row (even `[]`) is a full replace
// that overrides it entirely — exactly this set, in this order, regardless
// of current item counts. That is what makes a lane the viewer explicitly
// checked stay visible even once it is empty, and a lane they explicitly
// unchecked stay hidden even with open items in it. A stale id (an
// employee who left the roster) is dropped; SUPPLIERS_LANE_ID can never go
// stale the same way, since it names a lane, not a specific person. Pure and
// exported on its own so it can be tested without rendering WorkEntityScreen.
export function effectiveBoardLaneIds(
  savedOrder: string[] | null,
  defaultOrder: string[],
  employees: { id: string; name: string }[],
): string[] {
  if (savedOrder === null) return defaultOrder;
  return savedOrder.filter((id) => id === SUPPLIERS_LANE_ID || employees.some((e) => e.id === id));
}

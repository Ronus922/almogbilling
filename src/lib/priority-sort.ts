// Shared ordering rule for the tasks/issues lists: urgent items above all,
// then the current in-group order (a header-selected or server sort). Used by
// both the task and issue tables so the rule lives in one place.

/**
 * Stable-partition urgent items to the top while preserving the existing
 * in-group order. With the default sort (due date asc for tasks), this yields
 * "urgent first, then due date asc". Pure — does not mutate the input.
 */
export function urgentFirst<T extends { priority: string }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const au = a.item.priority === 'urgent' ? 0 : 1;
      const bu = b.item.priority === 'urgent' ? 0 : 1;
      if (au !== bu) return au - bu;
      return a.i - b.i; // keep the original (sorted) order within each group
    })
    .map((x) => x.item);
}

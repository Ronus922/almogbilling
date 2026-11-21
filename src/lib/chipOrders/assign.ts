// Chip orders inside the issue window (13/11/2026) — which order line each NEW
// chip number of the holder block is linked to. Pure, shared by the window and
// its tests.

export interface AssignableLine {
  item_id: string;
  chips_count: number;
  /** ACTIVE chips already linked to the line. */
  chips_linked: number;
}

/**
 * The lines are taken in the order given (the window passes the person's open
 * orders oldest first): each takes new numbers up to what it still misses,
 * and whatever is left over goes to the LAST line — more chips than ordered
 * are allowed (the window warns about it). No lines → nothing is linked.
 * Returns number → item_id.
 */
export function assignToOrderLines(numbers: readonly string[], lines: readonly AssignableLine[]): Map<string, string> {
  const out = new Map<string, string>();
  if (lines.length === 0) return out;
  const room = lines.map((l) => Math.max(0, l.chips_count - l.chips_linked));
  let li = 0;
  for (const n of numbers) {
    while (li < lines.length - 1 && room[li] <= 0) li++;
    out.set(n, lines[li].item_id);
    room[li]--;
  }
  return out;
}

/** How many of `numbers` each line receives (item_id → count). */
export function pendingPerLine(numbers: readonly string[], lines: readonly AssignableLine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of assignToOrderLines(numbers, lines).values()) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

import { isCompletedIssueStatus } from '@/lib/constants/issues';
import type { IssueBoardColumn, IssueWithMeta } from '@/lib/types/issues';

// The issues kanban by STAGE OF HANDLING (phase C, 03/10/2026), a MANUAL board
// since 04/10/2026. RTL order, right to left: ממתין לשיוך · לטיפול היום ·
// בטיפול · בוצע.
//
// The stage rule (issueBoardColumn) — handlers (entity_assignees, exposed as
// `assignees`), status and issues.due_date — only seeds a card: it is written
// to issues.board_column when the issue is created, and from then on only a
// drag moves the card (boardColumn). Inside a column the order is
// issues.sort_order; compareBoardIssues breaks ties only, i.e. orders cards
// nobody has placed yet. A resolved / closed issue is in "בוצע" by its status.

export type IssueBoardColumnKey = IssueBoardColumn | 'done';

export interface IssueBoardColumnDef {
  key: IssueBoardColumnKey;
  label: string;
  dot: string;
  empty: string;
}

export const ISSUE_BOARD_COLUMNS: IssueBoardColumnDef[] = [
  { key: 'awaiting', label: 'ממתין לשיוך', dot: 'bg-amber-500', empty: 'אין תקלות שממתינות לשיוך' },
  { key: 'today', label: 'לטיפול היום', dot: 'bg-rose-500', empty: 'אין תקלות לטיפול היום' },
  { key: 'in_progress', label: 'בטיפול', dot: 'bg-blue-500', empty: 'אין תקלות בטיפול' },
  { key: 'done', label: 'בוצע', dot: 'bg-emerald-500', empty: 'גררו לכאן לסימון כבוצע' },
];

/** The building's day boundary — "today" never follows the viewer's clock zone. */
export const ISSUE_BOARD_TIME_ZONE = 'Asia/Jerusalem';

/** 'YYYY-MM-DD' of `now` on the Asia/Jerusalem calendar. */
export function jerusalemToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISSUE_BOARD_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export type BoardIssue = Pick<
  IssueWithMeta,
  | 'status' | 'is_archived' | 'assignees' | 'due_date' | 'due_time' | 'priority' | 'created_at'
  | 'sort_order' | 'board_column'
>;

/** The stage rule for a not-done issue: no handler → ממתין לשיוך (even with a
 *  date); due today or earlier → לטיפול היום; due later or undated → בטיפול. */
export function initialBoardColumn(hasHandler: boolean, dueDate: string | null, today: string): IssueBoardColumn {
  if (!hasHandler) return 'awaiting';
  if (dueDate && dueDate <= today) return 'today';
  return 'in_progress';
}

/**
 * The column the stage rule computes, or null when the issue is not on the
 * board at all (archived). Resolved / closed → בוצע. This is the seed of a new
 * card and the definition of the table's "לטיפול היום" filter — the card's
 * place on the board is boardColumn().
 */
export function issueBoardColumn(issue: BoardIssue, today: string): IssueBoardColumnKey | null {
  if (issue.is_archived) return null;
  if (isCompletedIssueStatus(issue.status)) return 'done';
  return initialBoardColumn(issue.assignees.length > 0, issue.due_date, today);
}

/** Where the card sits on the board: its stored column (placed by a drag, or
 *  seeded at insert), the stage rule only when none is stored. */
export function boardColumn(issue: BoardIssue, today: string): IssueBoardColumnKey | null {
  const computed = issueBoardColumn(issue, today);
  if (computed === null || computed === 'done') return computed;
  return issue.board_column ?? computed;
}

function utcDay(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days past the due date (0 when due today, later, undated or done). */
export function overdueDays(issue: BoardIssue, today: string): number {
  if (!issue.due_date || isCompletedIssueStatus(issue.status)) return 0;
  const days = Math.round((utcDay(today) - utcDay(issue.due_date)) / 86_400_000);
  return days > 0 ? days : 0;
}

/** "באיחור יום אחד" / "באיחור 3 ימים". */
export function overdueLabel(days: number): string {
  return days === 1 ? 'באיחור יום אחד' : `באיחור ${days} ימים`;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2 };

/**
 * The computed order — the tie-break of sort_order, so the order of cards no
 * one has placed yet: urgent → high → normal, then by due date (undated last),
 * then time, then the oldest first. In "לטיפול היום" every overdue card comes
 * before every card due today.
 */
export function compareBoardIssues(column: IssueBoardColumnKey, today: string) {
  return (a: BoardIssue, b: BoardIssue): number => {
    if (column === 'today') {
      const late = (overdueDays(a, today) > 0 ? 0 : 1) - (overdueDays(b, today) > 0 ? 0 : 1);
      if (late !== 0) return late;
    }
    const pr = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    if (pr !== 0) return pr;
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    if (a.due_time !== b.due_time) {
      if (!a.due_time) return 1;
      if (!b.due_time) return -1;
      return a.due_time < b.due_time ? -1 : 1;
    }
    return a.created_at.localeCompare(b.created_at);
  };
}

/** The board: every column's cards, top to bottom. Archived issues are left out. */
export function groupBoard<T extends BoardIssue>(
  issues: T[],
  today: string,
): Record<IssueBoardColumnKey, T[]> {
  const out: Record<IssueBoardColumnKey, T[]> = { awaiting: [], today: [], in_progress: [], done: [] };
  for (const i of issues) {
    const col = boardColumn(i, today);
    if (col) out[col].push(i);
  }
  for (const key of Object.keys(out) as IssueBoardColumnKey[]) {
    const computed = compareBoardIssues(key, today);
    out[key].sort((a, b) => a.sort_order - b.sort_order || computed(a, b));
  }
  return out;
}

/** sort_order spacing: room for many drops between two cards before a column
 *  has to be renumbered. A new issue goes BOARD_SORT_GAP above the lowest one. */
export const BOARD_SORT_GAP = 1024;

/**
 * The sort_order writes that drop `movedId` into `column`, directly above
 * `beforeId` (null = at the bottom): issue id → new sort_order, the dragged
 * card always included (the caller also stores `column` on it). Only the
 * dragged card is written when its new neighbours leave room; otherwise the
 * whole column is renumbered, writing just the cards whose value changes.
 * null when `beforeId` is not a card of that column — a stale board.
 *
 * The same plan runs in the browser (the optimistic board) and on the server
 * (the write, over every card on the board, so a filtered view still lands the
 * card right above the one it was dropped on).
 */
export function planBoardMove<T extends BoardIssue & { id: string }>(
  issues: T[],
  movedId: string,
  column: IssueBoardColumn,
  beforeId: string | null,
  today: string,
): Map<string, number> | null {
  const moved = issues.find((i) => i.id === movedId);
  if (!moved) return null;
  const rest = groupBoard(issues, today)[column].filter((i) => i.id !== movedId);
  const at = beforeId === null ? rest.length : rest.findIndex((i) => i.id === beforeId);
  if (at < 0) return null;

  const prev = rest[at - 1]?.sort_order;
  const next = rest[at]?.sort_order;
  // An empty column takes any value — keep the card's own.
  if (prev === undefined) return new Map([[movedId, next === undefined ? moved.sort_order : next - BOARD_SORT_GAP]]);
  if (next === undefined) return new Map([[movedId, prev + BOARD_SORT_GAP]]);
  if (next - prev >= 2) return new Map([[movedId, prev + Math.floor((next - prev) / 2)]]);

  const order = [...rest.slice(0, at), moved, ...rest.slice(at)];
  const plan = new Map<string, number>();
  order.forEach((i, n) => {
    const value = n * BOARD_SORT_GAP;
    if (i.id === movedId || i.sort_order !== value) plan.set(i.id, value);
  });
  return plan;
}

/** "העבר אל…" (the phone's card menu): every column but the one the card sits in. */
export function moveToTargets(issue: BoardIssue, today: string): IssueBoardColumnDef[] {
  const here = boardColumn(issue, today);
  return ISSUE_BOARD_COLUMNS.filter((c) => c.key !== here);
}

export type MoveToAction =
  | { kind: 'move'; column: IssueBoardColumn; beforeId: string | null }
  /** "בוצע" closes the issue, exactly like a drop on it. */
  | { kind: 'complete' };

/** A choice in "העבר אל…": the card goes to the TOP of that column — above
 *  its first card (null = the column is empty) — or, for "בוצע", is closed. */
export function moveToAction<T extends BoardIssue & { id: string }>(
  issues: T[],
  movedId: string,
  target: IssueBoardColumnKey,
  today: string,
): MoveToAction {
  if (target === 'done') return { kind: 'complete' };
  const top = groupBoard(issues, today)[target].find((i) => i.id !== movedId);
  return { kind: 'move', column: target, beforeId: top?.id ?? null };
}

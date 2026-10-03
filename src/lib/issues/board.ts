import { isCompletedIssueStatus } from '@/lib/constants/issues';
import type { IssueWithMeta } from '@/lib/types/issues';

// The issues kanban by STAGE OF HANDLING (phase C, 03/10/2026). Four computed
// columns replace the priority lanes — no new status and no new date column:
// the column is derived from the handlers (entity_assignees, exposed as
// `assignees`), the status and issues.due_date. Priority stays a tag, a filter
// and the first sort key inside a column.
//
// RTL order, right to left: ממתין לשיוך · לטיפול היום · בטיפול · בוצע.

export type IssueBoardColumnKey = 'awaiting' | 'today' | 'in_progress' | 'done';

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
  'status' | 'is_archived' | 'assignees' | 'due_date' | 'due_time' | 'priority' | 'created_at'
>;

/**
 * Which column an issue sits in, or null when it is not on the board at all
 * (archived).
 *   ממתין לשיוך — not done, no handler of either kind — even with a date;
 *   לטיפול היום — handled, due today or earlier (earlier = "באיחור");
 *   בטיפול      — handled, due later or with no date;
 *   בוצע        — resolved / closed.
 */
export function issueBoardColumn(issue: BoardIssue, today: string): IssueBoardColumnKey | null {
  if (issue.is_archived) return null;
  if (isCompletedIssueStatus(issue.status)) return 'done';
  if (issue.assignees.length === 0) return 'awaiting';
  if (issue.due_date && issue.due_date <= today) return 'today';
  return 'in_progress';
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
 * Order inside a column: urgent → high → normal, then by due date (undated
 * last), then time, then the oldest first. In "לטיפול היום" every overdue card
 * comes before every card due today.
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

/** The board: every column's cards, sorted. Archived issues are left out. */
export function groupBoard<T extends BoardIssue>(
  issues: T[],
  today: string,
): Record<IssueBoardColumnKey, T[]> {
  const out: Record<IssueBoardColumnKey, T[]> = { awaiting: [], today: [], in_progress: [], done: [] };
  for (const i of issues) {
    const col = issueBoardColumn(i, today);
    if (col) out[col].push(i);
  }
  for (const key of Object.keys(out) as IssueBoardColumnKey[]) {
    out[key].sort(compareBoardIssues(key, today));
  }
  return out;
}

/** "ממתין לשיוך" is computed from the handlers — a card cannot be dropped back
 *  into it; removing the handlers in the panel is what puts it there. */
export function canDropIntoColumn(target: IssueBoardColumnKey): boolean {
  return target !== 'awaiting';
}

export type BoardDrop =
  | { kind: 'noop' }
  | { kind: 'blocked' }
  /** Handled already: due_date := today, nothing else. */
  | { kind: 'set_due_today'; dueDate: string }
  /** The existing issue panel; `prefillDueDate` for the today column. Closing
   *  it without saving changes nothing, so the card stays where it was. */
  | { kind: 'open_panel'; prefillDueDate: string | null }
  /** Status "closed", exactly as the "בוצע" lane always did. */
  | { kind: 'complete' };

/** What dropping `issue` onto `target` does. */
export function boardDropAction(issue: BoardIssue, target: IssueBoardColumnKey, today: string): BoardDrop {
  if (issueBoardColumn(issue, today) === target) return { kind: 'noop' };
  switch (target) {
    case 'awaiting':
      return { kind: 'blocked' };
    case 'today':
      return issue.assignees.length > 0
        ? { kind: 'set_due_today', dueDate: today }
        : { kind: 'open_panel', prefillDueDate: today };
    case 'in_progress':
      return { kind: 'open_panel', prefillDueDate: null };
    case 'done':
      return { kind: 'complete' };
  }
}

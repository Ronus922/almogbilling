import 'server-only';
import type { IssueStatus } from '@/lib/types/issues';
import type { TaskStatus } from '@/lib/types/tasks';
import type { WorkItemStatusV2 } from '@/lib/types/workItems';

/**
 * status_v2 is DERIVED from the legacy status column, never written directly
 * by a client — see db/migrations/20261011220356_tasks_issues_unified_phase1.sql
 * for the one-time backfill this mirrors. Keeping both in sync on every write
 * (not just at migration time) is what lets every legacy status-reading
 * consumer (the calendar overlay, task_due_soon, reminders) keep working
 * unchanged while the new unified module writes `status_v2` for free.
 */
export function issueStatusV2(status: IssueStatus): WorkItemStatusV2 {
  switch (status) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'resolved':
    case 'closed':
      return 'closed';
  }
}

export function taskStatusV2(status: TaskStatus): WorkItemStatusV2 {
  switch (status) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'done':
    case 'cancelled':
      return 'closed';
  }
}

/**
 * The legacy status value to write when the unified module's chip/board
 * advances an item to the closed state — 'closed' (issues) / 'done' (tasks),
 * the terminal value that reads as "finished" rather than "cancelled". The
 * fine old-world distinction (resolved vs closed, done vs cancelled) is not
 * surfaced anywhere the new UI reaches; the full edit panel can still set it
 * precisely via its own status field.
 */
export const ISSUE_CLOSED_STATUS: IssueStatus = 'closed';
export const TASK_CLOSED_STATUS: TaskStatus = 'done';

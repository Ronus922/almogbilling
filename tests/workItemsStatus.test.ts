import { describe, it, expect } from 'vitest';
import { issueStatusV2, taskStatusV2, ISSUE_CLOSED_STATUS, TASK_CLOSED_STATUS } from '@/lib/workItems/status';
import type { IssueStatus } from '@/lib/types/issues';
import type { TaskStatus } from '@/lib/types/tasks';

// The application-level mirror of the one-time migration backfill
// (db/migrations/20261011220356_tasks_issues_unified_phase1.sql) — every
// future write re-derives status_v2 from the legacy status the SAME way the
// migration backfilled it, so the two never drift. Pins every legacy value on
// both tables.
//
// nextIssueStatusOnChip/nextTaskStatusOnChip (the old 3-state open ->
// in_progress -> closed chip-advance) were removed 12/10/2026: the reference
// design's card has no status chip to click at all (DESIGN.md §41) — "סמן
// כבוצע" is a direct, single-step close (ISSUE_CLOSED_STATUS/TASK_CLOSED_
// STATUS below), never a cycle.

describe('issueStatusV2 — mirrors the migration backfill mapping', () => {
  const cases: [IssueStatus, 'open' | 'in_progress' | 'closed'][] = [
    ['open', 'open'],
    ['in_progress', 'in_progress'],
    ['resolved', 'closed'],
    ['closed', 'closed'],
  ];
  it.each(cases)('%s -> %s', (status, expected) => {
    expect(issueStatusV2(status)).toBe(expected);
  });
});

describe('taskStatusV2 — mirrors the migration backfill mapping', () => {
  const cases: [TaskStatus, 'open' | 'in_progress' | 'closed'][] = [
    ['open', 'open'],
    ['in_progress', 'in_progress'],
    ['done', 'closed'],
    ['cancelled', 'closed'],
  ];
  it.each(cases)('%s -> %s', (status, expected) => {
    expect(taskStatusV2(status)).toBe(expected);
  });
});

describe('ISSUE_CLOSED_STATUS / TASK_CLOSED_STATUS — the "סמן כבוצע" terminal value', () => {
  it('issues close to the terminal "finished" value, not "resolved"', () => {
    expect(ISSUE_CLOSED_STATUS).toBe('closed');
    expect(issueStatusV2(ISSUE_CLOSED_STATUS)).toBe('closed');
  });
  it('tasks close to "done", not "cancelled"', () => {
    expect(TASK_CLOSED_STATUS).toBe('done');
    expect(taskStatusV2(TASK_CLOSED_STATUS)).toBe('closed');
  });
});

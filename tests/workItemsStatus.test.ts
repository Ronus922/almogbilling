import { describe, it, expect } from 'vitest';
import {
  issueStatusV2, taskStatusV2, nextIssueStatusOnChip, nextTaskStatusOnChip,
} from '@/lib/workItems/status';
import type { IssueStatus } from '@/lib/types/issues';
import type { TaskStatus } from '@/lib/types/tasks';

// The application-level mirror of the one-time migration backfill
// (db/migrations/20261011220356_tasks_issues_unified_phase1.sql) — every
// future write re-derives status_v2 from the legacy status the SAME way the
// migration backfilled it, so the two never drift. Pins every legacy value on
// both tables.

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

describe('nextIssueStatusOnChip — open -> in_progress -> closed, no further', () => {
  it('open advances to in_progress', () => {
    expect(nextIssueStatusOnChip('open')).toBe('in_progress');
  });
  it('in_progress advances to closed (not resolved — chip-click has no notes field)', () => {
    expect(nextIssueStatusOnChip('in_progress')).toBe('closed');
  });
  it('a terminal status (closed or resolved) does not advance from the chip', () => {
    expect(nextIssueStatusOnChip('closed')).toBeNull();
    expect(nextIssueStatusOnChip('resolved')).toBeNull();
  });
});

describe('nextTaskStatusOnChip — open -> in_progress -> done, no further', () => {
  it('open advances to in_progress', () => {
    expect(nextTaskStatusOnChip('open')).toBe('in_progress');
  });
  it('in_progress advances to done', () => {
    expect(nextTaskStatusOnChip('in_progress')).toBe('done');
  });
  it('a terminal status (done or cancelled) does not advance from the chip', () => {
    expect(nextTaskStatusOnChip('done')).toBeNull();
    expect(nextTaskStatusOnChip('cancelled')).toBeNull();
  });
});

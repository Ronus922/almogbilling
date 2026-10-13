import { describe, it, expect } from 'vitest';
import { defaultBoardLaneOrder } from '@/lib/workItems/boardOrder';
import type { WorkItem } from '@/lib/types/workItems';

// The board's default lane set/order when the viewer never customized it
// (13/10/2026, decision 3): only employees with an open item in the viewer's
// OWN scoped `items` — busiest first, then alphabetical (Hebrew collation).

function mkItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    kind: 'issue',
    id: 'x',
    title: 't',
    priority: 'normal',
    status_v2: 'open',
    blocked: false,
    blocked_reason: null,
    due_date: null,
    assignee: null,
    source: 'staff',
    is_from_resident: false,
    source_apartment: null,
    source_reporter_name: null,
    comment_count: 0,
    attachment_count: 0,
    is_recurring: false,
    is_recurring_paused: false,
    created_by: null,
    created_by_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    closed_at: null,
    sort_index: null,
    is_new: false,
    assignees: [],
    ...overrides,
  };
}

const userAssignee = (id: string) => ({ kind: 'user' as const, id, display_name: id });

describe('defaultBoardLaneOrder', () => {
  it('an employee with zero open items in scope gets no lane at all', () => {
    const items = [mkItem({ id: '1', assignee: null })]; // unassigned — nobody's lane
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual([]);
  });

  it('orders by open-item count, busiest first', () => {
    const items = [
      mkItem({ id: '1', assignee: userAssignee('alice') }),
      mkItem({ id: '2', assignee: userAssignee('bob') }),
      mkItem({ id: '3', assignee: userAssignee('bob') }),
    ];
    const employees = [{ id: 'alice', name: 'אליס' }, { id: 'bob', name: 'בוב' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual(['bob', 'alice']);
  });

  it('ties break alphabetically, Hebrew collation', () => {
    const items = [
      mkItem({ id: '1', assignee: userAssignee('bob') }),
      mkItem({ id: '2', assignee: userAssignee('alice') }),
    ];
    const employees = [{ id: 'bob', name: 'בוב' }, { id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual(['alice', 'bob']); // א before ב
  });

  it('a closed item does not count toward the open-item total', () => {
    const items = [mkItem({ id: '1', assignee: userAssignee('alice'), status_v2: 'closed' })];
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual([]);
  });

  it('a supplier-assigned item does not give any employee a lane', () => {
    const items = [mkItem({ id: '1', assignee: { kind: 'supplier', id: 's1', display_name: 'ספק' } })];
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual([]);
  });
});

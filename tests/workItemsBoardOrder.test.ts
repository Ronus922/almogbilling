import { describe, it, expect } from 'vitest';
import { defaultBoardLaneOrder, effectiveBoardLaneIds } from '@/lib/workItems/boardOrder';
import { SUPPLIERS_LANE_ID } from '@/lib/constants/workItems';
import type { WorkItem } from '@/lib/types/workItems';

// The board's default lane set/order when the viewer never customized it
// (13/10/2026, decision 3; extended 14/10/2026 to the suppliers lane): only
// employees with an open item in the viewer's OWN scoped `items` — busiest
// first, then alphabetical (Hebrew collation). The combined "ספקים" lane
// follows the same "has an open item" rule but is never part of that sort —
// it is appended at the end when it appears at all.

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

  it('an open supplier-assigned item does not give any employee a lane', () => {
    const items = [mkItem({ id: '1', assignee: { kind: 'supplier', id: 's1', display_name: 'ספק' } })];
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual([SUPPLIERS_LANE_ID]);
  });

  it('an open supplier-assigned item adds the suppliers lane, appended after the employee lanes', () => {
    const items = [
      mkItem({ id: '1', assignee: userAssignee('alice') }),
      mkItem({ id: '2', assignee: { kind: 'supplier', id: 's1', display_name: 'ספק' } }),
    ];
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual(['alice', SUPPLIERS_LANE_ID]);
  });

  it('no open supplier-assigned item → no suppliers lane', () => {
    const items = [mkItem({ id: '1', assignee: userAssignee('alice') })];
    const employees = [{ id: 'alice', name: 'אליס' }];
    expect(defaultBoardLaneOrder(items, employees)).toEqual(['alice']);
  });

  it('a closed supplier-assigned item does not add the suppliers lane', () => {
    const items = [mkItem({ id: '1', assignee: { kind: 'supplier', id: 's1', display_name: 'ספק' }, status_v2: 'closed' })];
    const employees: { id: string; name: string }[] = [];
    expect(defaultBoardLaneOrder(items, employees)).toEqual([]);
  });
});

// Explicit selection overrides the default, for every lane — employee or
// suppliers alike (14/10/2026, "התאמת לוח — ספקים + בחירה מפורשת גוברת",
// decision 1). The suppliers lane used to be driven purely by whether a live
// item was currently assigned to a supplier, with no saved preference able to
// override that — this is the fix.
describe('effectiveBoardLaneIds', () => {
  const employees = [{ id: 'alice', name: 'אליס' }, { id: 'bob', name: 'בוב' }];

  it('no saved row at all → falls back to the default order as-is', () => {
    expect(effectiveBoardLaneIds(null, ['alice'], employees)).toEqual(['alice']);
  });

  it('a saved row with an explicitly-checked, currently-empty employee lane shows it anyway', () => {
    // 'bob' has no open item (would be absent from the default), but was
    // explicitly checked in "התאמת לוח" and saved — stays visible.
    expect(effectiveBoardLaneIds(['alice', 'bob'], ['alice'], employees)).toEqual(['alice', 'bob']);
  });

  it('a saved row that leaves an employee out hides them, even with open items', () => {
    // The default would include 'bob' (an open item), but the saved
    // preference explicitly omits them — hidden regardless.
    expect(effectiveBoardLaneIds(['alice'], ['alice', 'bob'], employees)).toEqual(['alice']);
  });

  it('an explicitly-checked, currently-empty suppliers lane shows it anyway — the exact bug this fixes', () => {
    expect(effectiveBoardLaneIds([SUPPLIERS_LANE_ID, 'alice'], ['alice'], employees))
      .toEqual([SUPPLIERS_LANE_ID, 'alice']);
  });

  it('an explicitly-unchecked suppliers lane hides it even with open supplier items', () => {
    // The default has the suppliers lane (an open supplier item exists), but
    // the saved preference explicitly leaves SUPPLIERS_LANE_ID out.
    expect(effectiveBoardLaneIds(['alice'], ['alice', SUPPLIERS_LANE_ID], employees)).toEqual(['alice']);
  });

  it('an empty saved array hides every lane, employees and suppliers both', () => {
    expect(effectiveBoardLaneIds([], ['alice', SUPPLIERS_LANE_ID], employees)).toEqual([]);
  });

  it('a stale employee id (left the roster) is dropped, but the suppliers sentinel never goes stale that way', () => {
    expect(effectiveBoardLaneIds(['carol', SUPPLIERS_LANE_ID, 'alice'], [], employees))
      .toEqual([SUPPLIERS_LANE_ID, 'alice']);
  });

  it('saved order is respected exactly, suppliers lane included anywhere in the sequence', () => {
    expect(effectiveBoardLaneIds([SUPPLIERS_LANE_ID, 'bob', 'alice'], [], employees))
      .toEqual([SUPPLIERS_LANE_ID, 'bob', 'alice']);
  });
});

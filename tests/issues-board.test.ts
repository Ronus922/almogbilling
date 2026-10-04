import { describe, expect, it } from 'vitest';
import {
  BOARD_SORT_GAP, ISSUE_BOARD_COLUMNS, boardColumn, compareBoardIssues, groupBoard, initialBoardColumn,
  issueBoardColumn, jerusalemToday, moveToAction, moveToTargets, overdueDays, overdueLabel, planBoardMove,
  type BoardIssue,
} from '@/lib/issues/board';
import type { IssueBoardColumn } from '@/lib/types/issues';
import { residentReportLabel } from '@/components/issues/IssueReporter';

// The issues kanban by stage of handling (phase C, 03/10/2026), a manual board
// since 04/10/2026: the stage rule ("today" on the Asia/Jerusalem calendar)
// seeds a card's column, a drag is the only thing that moves it, and the order
// inside a column is sort_order — the computed order only breaks ties.

const TODAY = '2026-10-03';
const HANDLER = [{ assignee_type: 'user', user_id: 'u1', supplier_id: null, display_name: 'עובד' }] as BoardIssue['assignees'];

function issue(over: Partial<BoardIssue> & { id?: string } = {}): BoardIssue & { id: string } {
  return {
    id: over.id ?? 'x',
    status: 'open',
    is_archived: false,
    assignees: [],
    due_date: null,
    due_time: null,
    priority: 'normal',
    created_at: '2026-10-01T08:00:00Z',
    sort_order: 0,
    board_column: null,
    ...over,
  };
}

describe('the stage rule (seeds a new card; the table\'s "לטיפול היום")', () => {
  it('no handler → ממתין לשיוך, even when due today (or in progress)', () => {
    expect(issueBoardColumn(issue(), TODAY)).toBe('awaiting');
    expect(issueBoardColumn(issue({ due_date: TODAY }), TODAY)).toBe('awaiting');
    expect(issueBoardColumn(issue({ status: 'in_progress', due_date: '2026-10-01' }), TODAY)).toBe('awaiting');
  });

  it('handled + due today → לטיפול היום; handled + due yesterday → לטיפול היום, "באיחור"', () => {
    expect(issueBoardColumn(issue({ assignees: HANDLER, due_date: TODAY }), TODAY)).toBe('today');
    const late = issue({ assignees: HANDLER, due_date: '2026-10-02' });
    expect(issueBoardColumn(late, TODAY)).toBe('today');
    expect(overdueDays(late, TODAY)).toBe(1);
    expect(overdueLabel(1)).toBe('באיחור יום אחד');
    expect(overdueDays(issue({ assignees: HANDLER, due_date: '2026-09-28' }), TODAY)).toBe(5);
    expect(overdueLabel(5)).toBe('באיחור 5 ימים');
    expect(overdueDays(issue({ assignees: HANDLER, due_date: TODAY }), TODAY)).toBe(0);
  });

  it('handled + due tomorrow, or no date → בטיפול', () => {
    expect(issueBoardColumn(issue({ assignees: HANDLER, due_date: '2026-10-04' }), TODAY)).toBe('in_progress');
    expect(issueBoardColumn(issue({ assignees: HANDLER }), TODAY)).toBe('in_progress');
  });

  it('resolved / closed → בוצע (never "late"); archived → not on the board', () => {
    expect(issueBoardColumn(issue({ status: 'closed', assignees: HANDLER, due_date: '2026-09-01' }), TODAY)).toBe('done');
    expect(issueBoardColumn(issue({ status: 'resolved' }), TODAY)).toBe('done');
    expect(overdueDays(issue({ status: 'closed', due_date: '2026-09-01' }), TODAY)).toBe(0);
    expect(issueBoardColumn(issue({ is_archived: true, assignees: HANDLER, due_date: TODAY }), TODAY)).toBeNull();
    const board = groupBoard([issue({ id: 'arch', is_archived: true })], TODAY);
    expect(Object.values(board).flat()).toEqual([]);
  });

  it('the four columns, right to left', () => {
    expect(ISSUE_BOARD_COLUMNS.map((c) => c.label)).toEqual(['ממתין לשיוך', 'לטיפול היום', 'בטיפול', 'בוצע']);
  });
});

describe('"today" is the Asia/Jerusalem day', () => {
  it('23:30 UTC on 02/10 is already 03/10 in Jerusalem (UTC+3 in October)', () => {
    expect(jerusalemToday(new Date('2026-10-02T20:59:59Z'))).toBe('2026-10-02');
    expect(jerusalemToday(new Date('2026-10-02T21:00:00Z'))).toBe('2026-10-03');
    expect(jerusalemToday(new Date('2026-10-02T23:30:00Z'))).toBe('2026-10-03');
  });

  it('in winter the boundary moves to 22:00 UTC (UTC+2)', () => {
    expect(jerusalemToday(new Date('2026-12-15T21:59:59Z'))).toBe('2026-12-15');
    expect(jerusalemToday(new Date('2026-12-15T22:00:00Z'))).toBe('2026-12-16');
  });

  it('the stage rule turns at the Jerusalem midnight — a placed card does not', () => {
    const due = issue({ assignees: HANDLER, due_date: '2026-10-03' });
    expect(issueBoardColumn(due, jerusalemToday(new Date('2026-10-02T20:59:00Z')))).toBe('in_progress');
    expect(issueBoardColumn(due, jerusalemToday(new Date('2026-10-02T21:01:00Z')))).toBe('today');
    const placed = { ...due, board_column: 'in_progress' as const };
    expect(boardColumn(placed, jerusalemToday(new Date('2026-10-02T21:01:00Z')))).toBe('in_progress');
  });
});

describe('order inside a column', () => {
  it('urgent → high → normal, then by date (undated last), then the oldest', () => {
    const items = [
      issue({ id: 'normal-dated', priority: 'normal', due_date: '2026-10-05', assignees: HANDLER }),
      issue({ id: 'high-late', priority: 'high', due_date: '2026-10-09', assignees: HANDLER }),
      issue({ id: 'urgent', priority: 'urgent', assignees: HANDLER }),
      issue({ id: 'high-early', priority: 'high', due_date: '2026-10-04', assignees: HANDLER }),
      issue({ id: 'normal-undated', priority: 'normal', assignees: HANDLER }),
    ];
    expect([...items].sort(compareBoardIssues('in_progress', TODAY)).map((i) => i.id))
      .toEqual(['urgent', 'high-early', 'high-late', 'normal-dated', 'normal-undated']);
  });

  it('in לטיפול היום every overdue card comes first — even a normal one before an urgent one due today', () => {
    const board = groupBoard([
      issue({ id: 'urgent-today', priority: 'urgent', due_date: TODAY, assignees: HANDLER }),
      issue({ id: 'normal-late', priority: 'normal', due_date: '2026-10-01', assignees: HANDLER }),
      issue({ id: 'high-late', priority: 'high', due_date: '2026-10-02', assignees: HANDLER }),
      issue({ id: 'normal-today', priority: 'normal', due_date: TODAY, assignees: HANDLER }),
    ], TODAY);
    expect(board.today.map((i) => i.id)).toEqual(['high-late', 'normal-late', 'urgent-today', 'normal-today']);
  });
});

describe('where a card sits — manual placement', () => {
  it('the stored column wins over the stage rule, whatever the handlers or the date say', () => {
    expect(boardColumn(issue({ assignees: HANDLER, due_date: TODAY, board_column: 'awaiting' }), TODAY)).toBe('awaiting');
    expect(boardColumn(issue({ board_column: 'today' }), TODAY)).toBe('today');
    expect(boardColumn(issue({ assignees: HANDLER, due_date: '2026-09-01', board_column: 'in_progress' }), TODAY)).toBe('in_progress');
  });

  it('nothing stored → the stage rule, live', () => {
    expect(boardColumn(issue(), TODAY)).toBe('awaiting');
    expect(boardColumn(issue({ assignees: HANDLER, due_date: TODAY }), TODAY)).toBe('today');
  });

  it('resolved / closed is in בוצע and archived is off the board, whatever is stored', () => {
    expect(boardColumn(issue({ status: 'closed', board_column: 'today' }), TODAY)).toBe('done');
    expect(boardColumn(issue({ is_archived: true, board_column: 'today' }), TODAY)).toBeNull();
  });

  it('a new issue starts where the stage rule puts it', () => {
    expect(initialBoardColumn(false, TODAY, TODAY)).toBe('awaiting');
    expect(initialBoardColumn(true, '2026-10-01', TODAY)).toBe('today');
    expect(initialBoardColumn(true, '2026-10-09', TODAY)).toBe('in_progress');
    expect(initialBoardColumn(true, null, TODAY)).toBe('in_progress');
  });

  it('inside a column sort_order decides; the computed order only breaks a tie', () => {
    const board = groupBoard([
      issue({ id: 'urgent-low', priority: 'urgent', board_column: 'in_progress', sort_order: 2048 }),
      issue({ id: 'normal-top', priority: 'normal', board_column: 'in_progress', sort_order: -1024 }),
      issue({ id: 'tie-normal', priority: 'normal', board_column: 'in_progress', sort_order: 0 }),
      issue({ id: 'tie-urgent', priority: 'urgent', board_column: 'in_progress', sort_order: 0 }),
    ], TODAY);
    expect(board.in_progress.map((i) => i.id)).toEqual(['normal-top', 'tie-urgent', 'tie-normal', 'urgent-low']);
  });
});

describe('a drop — planBoardMove', () => {
  type Card = BoardIssue & { id: string };
  const card = (id: string, column: IssueBoardColumn, sortOrder: number): Card =>
    issue({ id, board_column: column, sort_order: sortOrder });
  /** The board after the plan is written — what the page shows and the server stores. */
  function after(cards: Card[], movedId: string, column: IssueBoardColumn, beforeId: string | null) {
    const plan = planBoardMove(cards, movedId, column, beforeId, TODAY);
    if (!plan) throw new Error('no plan');
    const next = cards.map((c) => {
      const so = plan.get(c.id);
      if (so === undefined) return c;
      return c.id === movedId ? { ...c, board_column: column, sort_order: so } : { ...c, sort_order: so };
    });
    return { plan, board: groupBoard(next, TODAY) };
  }
  const ids = (cards: Card[]) => cards.map((c) => c.id);

  const base = (): Card[] => [
    card('a1', 'awaiting', 0), card('a2', 'awaiting', BOARD_SORT_GAP),
    card('t1', 'today', 0), card('t2', 'today', BOARD_SORT_GAP), card('t3', 'today', 2 * BOARD_SORT_GAP),
    card('p1', 'in_progress', 0), card('p2', 'in_progress', BOARD_SORT_GAP),
  ];

  it('between two cards of another column: lands right there, and only the dragged card is written', () => {
    const { plan, board } = after(base(), 'p1', 'awaiting', 'a2');
    expect(ids(board.awaiting)).toEqual(['a1', 'p1', 'a2']);
    expect(ids(board.in_progress)).toEqual(['p2']);
    expect([...plan.keys()]).toEqual(['p1']);
    expect(plan.get('p1')).toBe(BOARD_SORT_GAP / 2);
  });

  it('within its own column: up to the top, down to the bottom', () => {
    expect(ids(after(base(), 't3', 'today', 't1').board.today)).toEqual(['t3', 't1', 't2']);
    expect(after(base(), 't3', 'today', 't1').plan.get('t3')).toBe(-BOARD_SORT_GAP);
    expect(ids(after(base(), 't1', 'today', null).board.today)).toEqual(['t2', 't3', 't1']);
    expect(after(base(), 't1', 'today', null).plan.get('t1')).toBe(3 * BOARD_SORT_GAP);
  });

  it('into an empty column: the card keeps its own sort_order', () => {
    const cards = base().filter((c) => c.board_column !== 'in_progress').concat(card('x', 'awaiting', 77));
    const { plan, board } = after(cards, 'x', 'in_progress', null);
    expect(ids(board.in_progress)).toEqual(['x']);
    expect(plan.get('x')).toBe(77);
  });

  it('no room between the neighbours (never placed: all 0) → the column is renumbered, unchanged cards untouched', () => {
    const cards = [card('n1', 'today', 0), card('n2', 'today', 0), card('n3', 'today', 0), card('m', 'awaiting', 0)];
    const before = ids(groupBoard(cards, TODAY).today);
    const { plan, board } = after(cards, 'm', 'today', before[1]);
    expect(ids(board.today)).toEqual([before[0], 'm', before[1], before[2]]);
    expect(plan.has(before[0])).toBe(false); // stays 0
    expect(plan.get('m')).toBe(BOARD_SORT_GAP);
  });

  it('a filtered board: the server plans over every card, so the drop still lands right above the card it was dropped on', () => {
    // The page showed only p1 / p2; "hidden" sits between them on the server.
    const cards = [card('p1', 'in_progress', 0), card('hidden', 'in_progress', 1), card('p2', 'in_progress', 2), card('m', 'today', 0)];
    const { board } = after(cards, 'm', 'in_progress', 'p2');
    expect(ids(board.in_progress)).toEqual(['p1', 'hidden', 'm', 'p2']);
  });

  it('a stale board — before_id is not in that column (any more) — plans nothing', () => {
    expect(planBoardMove(base(), 'p1', 'awaiting', 't1', TODAY)).toBeNull();
    expect(planBoardMove(base(), 'p1', 'awaiting', 'gone', TODAY)).toBeNull();
    expect(planBoardMove(base(), 'gone', 'awaiting', null, TODAY)).toBeNull();
  });

  it('never touches the handlers, the date or the priority — only sort_order (and the column, by the caller)', () => {
    const cards = [issue({ id: 'h', assignees: HANDLER, due_date: TODAY, priority: 'urgent', board_column: 'today' }), card('a1', 'awaiting', 0)];
    const { board } = after(cards, 'h', 'awaiting', 'a1');
    const moved = board.awaiting.find((c) => c.id === 'h');
    expect(moved).toMatchObject({ assignees: HANDLER, due_date: TODAY, priority: 'urgent', board_column: 'awaiting' });
  });
});

describe('"העבר אל…" — the phone\'s card menu', () => {
  type Card = BoardIssue & { id: string };
  const card = (id: string, column: IssueBoardColumn, sortOrder: number): Card =>
    issue({ id, board_column: column, sort_order: sortOrder });
  const cards = (): Card[] => [
    card('a1', 'awaiting', 0), card('a2', 'awaiting', BOARD_SORT_GAP),
    card('t1', 'today', -BOARD_SORT_GAP), card('t2', 'today', 0),
    card('p1', 'in_progress', 0),
  ];

  it('offers the three other columns, "בוצע" included, in board order', () => {
    expect(moveToTargets(cards()[0], TODAY).map((c) => c.key)).toEqual(['today', 'in_progress', 'done']);
    expect(moveToTargets(cards()[4], TODAY).map((c) => c.key)).toEqual(['awaiting', 'today', 'done']);
  });

  it('a column → the top of it: above its first card — and the drop plan puts it there', () => {
    const all = cards();
    const action = moveToAction(all, 'p1', 'today', TODAY);
    expect(action).toEqual({ kind: 'move', column: 'today', beforeId: 't1' });
    if (action.kind !== 'move') throw new Error('expected a move');
    const plan = planBoardMove(all, 'p1', action.column, action.beforeId, TODAY);
    const next = all.map((c) => (c.id === 'p1' ? { ...c, board_column: 'today' as const, sort_order: plan!.get('p1')! } : c));
    expect(groupBoard(next, TODAY).today.map((c) => c.id)).toEqual(['p1', 't1', 't2']);
  });

  it('an empty column → null (the plan keeps the card\'s own sort_order)', () => {
    expect(moveToAction(cards().filter((c) => c.id !== 'p1').concat(card('x', 'awaiting', 5)), 'x', 'in_progress', TODAY))
      .toEqual({ kind: 'move', column: 'in_progress', beforeId: null });
  });

  it('"בוצע" closes the issue, exactly like a drop on it', () => {
    expect(moveToAction(cards(), 'a1', 'done', TODAY)).toEqual({ kind: 'complete' });
  });
});

describe('the resident-report marking', () => {
  const base = { source: 'portal' as const, reporter_name: 'רונן בדיקה', reporter_apartment: '1210' };
  it('"דיווח דייר · <שם> · דירה <מספר> · <תפקיד>"; unidentified "דיווח דייר · לא מזוהה"; nothing on a staff issue', () => {
    expect(residentReportLabel({ ...base, reporter_role: 'owner' })).toBe('דיווח דייר · רונן בדיקה · דירה 1210 · בעלים');
    expect(residentReportLabel({ ...base, reporter_role: 'tenant' })).toBe('דיווח דייר · רונן בדיקה · דירה 1210 · שוכר');
    expect(residentReportLabel({ ...base, reporter_name: null, reporter_role: 'operator' })).toBe('דיווח דייר · דירה 1210 · מפעיל');
    expect(residentReportLabel(base)).toBe('דיווח דייר · רונן בדיקה · דירה 1210');
    expect(residentReportLabel({ ...base, reporter_name: 'לא מזוהה', reporter_apartment: null })).toBe('דיווח דייר · לא מזוהה');
    expect(residentReportLabel({ source: 'staff', reporter_name: null, reporter_apartment: null })).toBeNull();
  });
});

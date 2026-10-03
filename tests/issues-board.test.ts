import { describe, expect, it } from 'vitest';
import {
  ISSUE_BOARD_COLUMNS, boardDropAction, canDropIntoColumn, compareBoardIssues, groupBoard,
  issueBoardColumn, jerusalemToday, overdueDays, overdueLabel, type BoardIssue,
} from '@/lib/issues/board';
import { residentReportLabel } from '@/components/issues/IssueReporter';

// The issues kanban by stage of handling (phase C, 03/10/2026): four computed
// columns, "today" on the Asia/Jerusalem calendar, priority as the first sort
// key, and what each drop means.

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
    ...over,
  };
}

describe('which column', () => {
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

  it('a card due "tomorrow" moves into לטיפול היום when the Jerusalem day turns', () => {
    const due = issue({ assignees: HANDLER, due_date: '2026-10-03' });
    expect(issueBoardColumn(due, jerusalemToday(new Date('2026-10-02T20:59:00Z')))).toBe('in_progress');
    expect(issueBoardColumn(due, jerusalemToday(new Date('2026-10-02T21:01:00Z')))).toBe('today');
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

describe('drag and drop', () => {
  const awaiting = issue({ id: 'a' });
  const handledFuture = issue({ id: 'h', assignees: HANDLER, due_date: '2026-10-10' });

  it('into ממתין לשיוך is refused', () => {
    expect(canDropIntoColumn('awaiting')).toBe(false);
    expect(boardDropAction(handledFuture, 'awaiting', TODAY)).toEqual({ kind: 'blocked' });
    for (const k of ['today', 'in_progress', 'done'] as const) expect(canDropIntoColumn(k)).toBe(true);
  });

  it('into לטיפול היום sets today\'s date — or, with no handler yet, opens the panel with today filled in', () => {
    expect(boardDropAction(handledFuture, 'today', TODAY)).toEqual({ kind: 'set_due_today', dueDate: TODAY });
    expect(boardDropAction(awaiting, 'today', TODAY)).toEqual({ kind: 'open_panel', prefillDueDate: TODAY });
  });

  it('into בטיפול opens the issue panel; into בוצע closes it; onto its own column does nothing', () => {
    expect(boardDropAction(awaiting, 'in_progress', TODAY)).toEqual({ kind: 'open_panel', prefillDueDate: null });
    expect(boardDropAction(handledFuture, 'done', TODAY)).toEqual({ kind: 'complete' });
    expect(boardDropAction(handledFuture, 'in_progress', TODAY)).toEqual({ kind: 'noop' });
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

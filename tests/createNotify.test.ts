import { describe, it, expect } from 'vitest';
import {
  assigneeRefKey,
  filterAddedAssignees,
  buildMatrixRecipients,
  detailRows,
  detailRowsWhatsApp,
} from '@/services/createNotify';
import { recipientKey, type NotifySelection } from '@/lib/notify/selection';
import type { AssigneeRef } from '@/lib/types/assignee';

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const S1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function user(id: string, over: Partial<AssigneeRef> = {}): AssigneeRef {
  return { assignee_type: 'user', user_id: id, supplier_id: null, display_name: 'עובד', email: 'u@x.co', phone: '0500000000', ...over };
}
function supplier(id: string, over: Partial<AssigneeRef> = {}): AssigneeRef {
  return { assignee_type: 'supplier', user_id: null, supplier_id: id, display_name: 'ספק', email: 's@x.co', phone: '0511111111', ...over };
}
const EMAIL_ONLY = { email: true, whatsapp: false };

describe('assigneeRefKey', () => {
  it('keys a user / supplier ref the same way the UI + listEntityAssigneeKeys do', () => {
    expect(assigneeRefKey(user(U2))).toBe(`user:${U2}`);
    expect(assigneeRefKey(supplier(S1))).toBe(`supplier:${S1}`);
  });
});

describe('filterAddedAssignees — the edit-form "added set"', () => {
  it('returns only assignees whose key is NOT in the previous set', () => {
    const prev = new Set([`user:${ME}`]); // ME was already assigned
    const added = filterAddedAssignees(prev, [user(ME), user(U2), supplier(S1)]);
    expect(added.map(assigneeRefKey)).toEqual([`user:${U2}`, `supplier:${S1}`]);
  });

  it('treats a newly-added SUPPLIER as added (closes the supplier gap)', () => {
    const prev = new Set([`user:${ME}`, `user:${U2}`]);
    const added = filterAddedAssignees(prev, [user(ME), user(U2), supplier(S1)]);
    expect(added).toEqual([supplier(S1)]);
  });

  it('no new assignees → empty (matrix shows only "me")', () => {
    const prev = new Set([`user:${ME}`, `supplier:${S1}`]);
    expect(filterAddedAssignees(prev, [user(ME), supplier(S1)])).toEqual([]);
  });
});

describe('detailRows — enriched message details', () => {
  it('renders all rows, formatting the due date as DD/MM/YYYY HH:MM', () => {
    expect(
      detailRows({
        description: 'נזילה בתקרה',
        targetLabel: 'דירה 12',
        dueDate: '2026-07-20',
        dueTime: '14:30:00',
        assignedByName: 'רונן',
      }),
    ).toEqual([
      { label: 'תיאור', value: 'נזילה בתקרה' },
      { label: 'מיקום', value: 'דירה 12' },
      { label: 'תאריך יעד', value: '20/07/2026 14:30' },
      { label: 'הוקצה ע"י', value: 'רונן' },
    ]);
  });

  it('drops absent rows entirely — a null location renders NO line', () => {
    expect(
      detailRows({ description: null, targetLabel: null, dueDate: '2026-07-20', assignedByName: 'רונן' }),
    ).toEqual([
      { label: 'תאריך יעד', value: '20/07/2026' },
      { label: 'הוקצה ע"י', value: 'רונן' },
    ]);
    expect(detailRows(undefined)).toEqual([]);
  });

  it('detailRowsWhatsApp: joined lines with leading blank line; empty → ""', () => {
    expect(detailRowsWhatsApp([{ label: 'מיקום', value: 'דירה 12' }])).toBe('\n\nמיקום: דירה 12');
    expect(detailRowsWhatsApp([])).toBe('');
  });
});

describe('buildMatrixRecipients — opt-in, recipient-keyed', () => {
  it('sends ONLY the recipients explicitly selected', () => {
    const selection: NotifySelection = { me: EMAIL_ONLY }; // U2 NOT selected
    const out = buildMatrixRecipients({
      selection,
      meUserId: ME,
      assignees: [user(U2)],
      meMessage: 'me-msg',
      assigneeMessage: () => 'a-msg',
    });
    expect(out).toEqual([{ kind: 'user', userId: ME, selection: EMAIL_ONLY, message: 'me-msg' }]);
  });

  it('routes a selected SUPPLIER assignee (the previously-missing path)', () => {
    const selection: NotifySelection = { [recipientKey('supplier', S1)]: EMAIL_ONLY };
    const out = buildMatrixRecipients({
      selection,
      meUserId: ME,
      assignees: [supplier(S1)],
      meMessage: 'me-msg',
      assigneeMessage: (n) => `to ${n}`,
    });
    expect(out).toEqual([{ kind: 'supplier', supplierId: S1, selection: EMAIL_ONLY, message: 'to ספק' }]);
  });

  it('a user assignee equal to "me" is covered by the me row (no duplicate)', () => {
    const selection: NotifySelection = {
      me: EMAIL_ONLY,
      [recipientKey('user', ME)]: EMAIL_ONLY,
    };
    const out = buildMatrixRecipients({
      selection,
      meUserId: ME,
      assignees: [user(ME)],
      meMessage: 'me-msg',
      assigneeMessage: () => 'a-msg',
    });
    expect(out).toEqual([{ kind: 'user', userId: ME, selection: EMAIL_ONLY, message: 'me-msg' }]);
  });

  it('nothing selected → no recipients (default = silent)', () => {
    const out = buildMatrixRecipients({
      selection: {},
      meUserId: ME,
      assignees: [user(U2), supplier(S1)],
      meMessage: 'me-msg',
      assigneeMessage: () => 'a-msg',
    });
    expect(out).toEqual([]);
  });
});

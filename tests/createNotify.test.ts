import { describe, it, expect } from 'vitest';
import {
  assigneeRefKey,
  filterAddedAssignees,
  buildMatrixRecipients,
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

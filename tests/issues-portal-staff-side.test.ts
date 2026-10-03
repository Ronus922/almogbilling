import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';
import type { IssueWithMeta } from '@/lib/types/issues';

// The issues module's side of a portal report, through the REAL staff guard
// chain (requirePermission → getCurrentActor → session + user_permissions):
//   • GET /api/issues/[id] sends the reporter's phone ONLY to contacts:view —
//     for anyone else the key is null and the phone is never even read;
//   • POST /api/issues (the staff screen) still rings every active admin
//     except the reporter, exactly as before notifyAdminsOfIssueReported moved
//     to src/services/issueReported.ts;
//   • GET /api/issues maps "מדיירים" / "ממתין לשיוך" to the list filters.

const PHONE = '+972521112233';

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
  issue: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: h.permRows })) }));
vi.mock('@/lib/db/issues', () => ({
  getIssueById: vi.fn(async () => h.issue),
  getIssueReporterPhone: vi.fn(async () => PHONE),
  listIssueComments: vi.fn(async () => []),
  getIssueAssigneeStatus: vi.fn(),
  updateIssue: vi.fn(),
  deleteIssue: vi.fn(),
  listIssues: vi.fn(async () => []),
  getIssueKpis: vi.fn(async () => ({ open: 0, urgent: 0, resolvedThisMonth: 0 })),
  createIssue: vi.fn(async () => h.issue),
}));
vi.mock('@/lib/db/reminders', () => ({
  listRemindersForEntity: vi.fn(async () => []),
  createReminder: vi.fn(),
  deleteRemindersForEntity: vi.fn(),
}));
vi.mock('@/lib/db/entityAssignees', () => ({ listEntityAssigneeKeys: vi.fn(async () => []), listEntityUserIds: vi.fn(async () => []) }));
vi.mock('@/lib/db/notifications', () => ({ deleteNotificationsForEntity: vi.fn() }));
vi.mock('@/lib/db/suppliers', () => ({ supplierExists: vi.fn(async () => true) }));
vi.mock('@/lib/db/users', () => ({
  listActiveAdmins: vi.fn(async () => [{ id: 'u-reporter', name: 'אני' }, { id: 'admin-2', name: 'אחר' }]),
}));
vi.mock('@/lib/storage/issueStorage', () => ({ imageUrlForPath: (p: string) => `/api/files/issue-attachments/${p}`, removeIssueImages: vi.fn() }));
vi.mock('@/services/notifications', () => ({ notifyIssue: vi.fn(async () => undefined), createNotification: vi.fn(async () => undefined) }));
vi.mock('@/services/createNotify', () => ({
  dispatchCreateNotifications: vi.fn(),
  buildMatrixRecipients: vi.fn(() => []),
  filterAddedAssignees: vi.fn(() => []),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET as getOne } from '@/app/api/issues/[id]/route';
import { GET as list, POST as create } from '@/app/api/issues/route';
import { getIssueReporterPhone, listIssues } from '@/lib/db/issues';
import { createNotification } from '@/services/notifications';

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';

function issue(source: 'portal' | 'staff', assignedUserId: string | null = null): IssueWithMeta {
  return {
    id: ISSUE_ID, title: 'דיווח דייר · לובי', description: 'נורה שרופה', location_type: 'general', location_text: null,
    target_type: null, target_id: null, priority: 'high', status: 'open', due_date: null, due_time: null,
    images: [], videos: [], resolution_notes: null, resolved_at: null, is_archived: false, sort_order: 0,
    created_by: null, created_by_name: 'בעלת הדירה', created_at: '2026-10-03', updated_at: '2026-10-03',
    source, reporter_name: source === 'portal' ? 'בעלת הדירה' : null, reporter_apartment: source === 'portal' ? '520' : null,
    reporter_role: source === 'portal' ? 'owner' : null,
    reporter_location: source === 'portal' ? 'לובי' : null, reporter_area: null, ticket_number: source === 'portal' ? 1001 : null,
    assignees: assignedUserId
      ? [{ assignee_type: 'user', user_id: assignedUserId, supplier_id: null, display_name: 'עובד' }] as IssueWithMeta['assignees']
      : [],
    comment_count: 0, linked_task_id: null, target_label: null,
  };
}

function signIn(role: Role, rows: ModulePermission[] = [], id = `u-${role}`) {
  h.session = { sid: 's', user: { id, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

async function detail() {
  const res = await getOne(new NextRequest(`http://localhost/api/issues/${ISSUE_ID}`), { params: Promise.resolve({ id: ISSUE_ID }) });
  return { status: res.status, body: (await res.json()) as { reporter_phone?: string | null; issue?: Record<string, unknown> } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.permRows = [];
  h.issue = issue('portal');
});

describe('GET /api/issues/[id] — the reporter phone follows contacts:view', () => {
  it('admin and a default manager (contacts:view) receive it', async () => {
    signIn('admin');
    expect((await detail()).body.reporter_phone).toBe(PHONE);
    signIn('manager', DEFAULT_MANAGER);
    expect((await detail()).body.reporter_phone).toBe(PHONE);
  });

  it('a manager without contacts:view gets name + apartment but NO phone — never even read', async () => {
    signIn('manager', [{ module: 'issues', canView: true, canEdit: true }]);
    const { status, body } = await detail();
    expect(status).toBe(200);
    expect(body.reporter_phone).toBeNull();
    expect(body.issue?.reporter_name).toBe('בעלת הדירה');
    expect(body.issue?.reporter_apartment).toBe('520');
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(getIssueReporterPhone).not.toHaveBeenCalled();
  });

  it('a field worker assigned to the issue gets no phone (no contacts:view by default)', async () => {
    h.issue = issue('portal', 'u-cleaner');
    signIn('cleaner', DEFAULT_WORKER);
    const { status, body } = await detail();
    expect(status).toBe(200);
    expect(body.reporter_phone).toBeNull();
    expect(JSON.stringify(body)).not.toContain(PHONE);
    expect(getIssueReporterPhone).not.toHaveBeenCalled();
  });

  it('the issue row itself never carries a phone field', async () => {
    signIn('admin');
    const { body } = await detail();
    expect(body.issue).not.toHaveProperty('reporter_phone');
  });

  it('a staff issue: nothing to read, null for everyone', async () => {
    h.issue = issue('staff');
    signIn('admin');
    expect((await detail()).body.reporter_phone).toBeNull();
    expect(getIssueReporterPhone).not.toHaveBeenCalled();
  });
});

describe('POST /api/issues — the staff route still rings the admins as before', () => {
  it('every active admin except the reporter gets "תקלה חדשה נפתחה"', async () => {
    h.issue = issue('staff');
    signIn('manager', DEFAULT_MANAGER, 'u-reporter');
    const res = await create(new NextRequest('http://localhost/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'דליפה בחניון' }),
    }));
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(createNotification).toHaveBeenCalledTimes(1));
    const n = vi.mocked(createNotification).mock.calls[0]![0];
    expect(n.userId).toBe('admin-2');
    expect(n.type).toBe('issue_reported');
    expect(n.title).toBe('תקלה חדשה נפתחה');
    expect(n.dedupeKey).toBe(`issue_reported:${ISSUE_ID}:admin-2`);
  });
});

describe('GET /api/issues — "מדיירים" and "ממתין לשיוך" are filters, not statuses', () => {
  async function listWith(qs: string) {
    signIn('admin');
    await list(new NextRequest(`http://localhost/api/issues?${qs}`));
    return vi.mocked(listIssues).mock.calls.at(-1)![0];
  }

  it('source=portal & awaiting=1 reach the list query', async () => {
    const f = await listWith('source=portal&awaiting=1');
    expect(f.source).toBe('portal');
    expect(f.awaitingAssignment).toBe(true);
    expect(f.status).toBeUndefined();
  });

  it('anything else means no filter', async () => {
    const f = await listWith('source=staff&awaiting=yes');
    expect(f.source).toBeUndefined();
    expect(f.awaitingAssignment).toBe(false);
  });
});

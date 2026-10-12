import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MANAGER, DEFAULT_WORKER, type ModulePermission, type Role } from '@/lib/permissions/constants';
import type { TaskWithAssignee } from '@/lib/types/tasks';

// Row-level scope on /api/tasks/[id] (12/10/2026, Decisions Log: "עיצוב
// משותף, ישויות נפרדות", point 6) — this route had NO row-level check at all
// before today (unlike /api/issues/[id], which at least isolated field
// workers via the old issueAccess.ts); every role with tasks:view/edit could
// read, edit or delete ANY task by id. This pins the fix: the same
// workItemAccess rule issues now carries, applied uniformly to every role
// (there is no prior worker-specific behavior here to preserve). The pure
// rule itself is pinned in tests/workItemAccess.test.ts.

const TASK_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  permRows: [] as { module: string; can_view: boolean; can_edit: boolean }[],
  task: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db', () => ({ query: vi.fn(async () => ({ rows: h.permRows })) }));
vi.mock('@/lib/db/tasks', () => ({
  getTaskById: vi.fn(async () => h.task),
  getTaskUserAssignees: vi.fn(async () => []),
  updateTask: vi.fn(async () => h.task),
  deleteTask: vi.fn(async () => true),
  listTaskComments: vi.fn(async () => []),
}));
vi.mock('@/lib/db/reminders', () => ({
  listRemindersForEntity: vi.fn(async () => []),
  createReminder: vi.fn(),
  deleteRemindersForEntity: vi.fn(),
}));
vi.mock('@/lib/db/entityAssignees', () => ({
  listEntityAssigneeKeys: vi.fn(async () => []),
  wasAssignedByActor: vi.fn(async () => false),
}));
vi.mock('@/lib/db/notifications', () => ({ deleteNotificationsForEntity: vi.fn() }));
vi.mock('@/lib/db/suppliers', () => ({ supplierExists: vi.fn(async () => true) }));
vi.mock('@/lib/recurrence/series', () => ({
  applyRecurrenceOnSave: vi.fn(),
  completeRecurringOccurrence: vi.fn(),
  getRecurrenceById: vi.fn(async () => null),
  skipTaskOccurrence: vi.fn(),
}));
vi.mock('@/services/notifications', () => ({ notifyTask: vi.fn(async () => undefined) }));
vi.mock('@/services/createNotify', () => ({
  dispatchCreateNotifications: vi.fn(),
  buildMatrixRecipients: vi.fn(() => []),
  filterAddedAssignees: vi.fn(() => []),
}));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET as getOne, DELETE as deleteOne } from '@/app/api/tasks/[id]/route';
import { wasAssignedByActor } from '@/lib/db/entityAssignees';

function task(p: Partial<TaskWithAssignee> = {}): TaskWithAssignee {
  return {
    id: TASK_ID, title: 'משימה', description: null, priority: 'normal', status: 'open',
    due_date: null, due_time: null, is_archived: false, created_by: null, created_by_name: null,
    created_at: '2026-10-01', updated_at: '2026-10-01', target_type: null, target_id: null, target_label: null,
    recurrence_id: null, recurrence: null, assignees: [], comment_count: 0, source: 'staff',
    status_v2: 'open', blocked: false, blocked_reason: null, assignee_user_id: null, assignee_supplier_id: null,
    closed_at: null, archived_at: null, sort_index: null, is_recurring_paused: false,
    ...p,
  } as unknown as TaskWithAssignee;
}

function signIn(role: Role, rows: ModulePermission[] = [], id = `u-${role}`) {
  h.session = { sid: 's', user: { id, username: role, email: `${role}@t`, full_name: 'אני', role } };
  h.permRows = rows.map((r) => ({ module: r.module, can_view: r.canView, can_edit: r.canEdit }));
}

async function detail() {
  return getOne(new NextRequest(`http://localhost/api/tasks/${TASK_ID}`), { params: Promise.resolve({ id: TASK_ID }) });
}
async function remove() {
  return deleteOne(new NextRequest(`http://localhost/api/tasks/${TASK_ID}`, { method: 'DELETE' }), { params: Promise.resolve({ id: TASK_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(wasAssignedByActor).mockResolvedValue(false);
  h.session = null;
  h.permRows = [];
  h.task = task();
});

describe('GET /api/tasks/[id] — row-level scope (no existence oracle, same convention as issues)', () => {
  it('a worker gets 404 on a task assigned to someone else — there was NO check here before today', async () => {
    h.task = task({ assignee_user_id: 'u-other' });
    signIn('cleaner', DEFAULT_WORKER);
    expect((await detail()).status).toBe(404);
  });
  it('a worker gets 200 on their own task', async () => {
    h.task = task({ assignee_user_id: 'u-cleaner' });
    signIn('cleaner', DEFAULT_WORKER);
    expect((await detail()).status).toBe(200);
  });
  it('a manager gets 404 on an unassigned task they did not create — no blanket admin/manager access', async () => {
    signIn('manager', DEFAULT_MANAGER);
    expect((await detail()).status).toBe(404);
  });
  it('a manager gets 200 when they created it, even unassigned', async () => {
    h.task = task({ created_by: 'u-manager' });
    signIn('manager', DEFAULT_MANAGER);
    expect((await detail()).status).toBe(200);
  });
  it('a manager gets 200 when they performed the assignment write, even to someone else', async () => {
    h.task = task({ assignee_user_id: 'u-other' });
    vi.mocked(wasAssignedByActor).mockResolvedValue(true);
    signIn('manager', DEFAULT_MANAGER);
    expect((await detail()).status).toBe(200);
    expect(wasAssignedByActor).toHaveBeenCalledWith('task', TASK_ID, 'u-manager');
  });
});

describe('DELETE /api/tasks/[id] — same scope, 403 (forbidden) rather than 404', () => {
  it('fetches the row first and rejects with 403 on a foreign task — this route used to delete unconditionally', async () => {
    h.task = task({ assignee_user_id: 'u-other' });
    signIn('manager', DEFAULT_MANAGER);
    const res = await remove();
    expect(res.status).toBe(403);
  });
  it('204 when the actor is the primary assignee', async () => {
    h.task = task({ assignee_user_id: 'u-manager' });
    signIn('manager', DEFAULT_MANAGER);
    expect((await remove()).status).toBe(204);
  });
});

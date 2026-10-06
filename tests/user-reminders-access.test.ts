import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { reminderPatchAllowed, reminderRole } from '@/lib/userReminders/access';

// Row-level access to user reminders (06/10/2026), through the REAL guard
// chain (requirePermission → getCurrentActor) and the real route code; only
// the session lookup, the pool, the audit writer and the attachment rows are
// fakes. Locked here:
//   • the list is always the SESSION user's set — a client-sent involvingUser
//     (any id) never reaches the query;
//   • a single GET answers 404 to anyone but the creator and the assignee;
//   • PATCH: the creator changes anything; the assignee only `status`, any
//     other key beside it is 403 and nothing is written; a stranger is 403;
//   • DELETE: the creator alone; the assignee and a stranger get 403.
// The actors are super admins so the module gate (user_reminders:edit) passes
// for all three — what differs is who they are to the ROW.

const UID = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const CREATOR = { id: UID('a'), username: 'alef', email: 'a@x', full_name: 'אלף', role: 'super_admin' };
const ASSIGNEE = { id: UID('b'), username: 'bet', email: 'b@x', full_name: 'בית', role: 'super_admin' };
const STRANGER = { id: UID('c'), username: 'gimel', email: 'c@x', full_name: 'גימל', role: 'super_admin' };
const R_ID = UID('d');
const MISSING = UID('e');

const REMINDER = {
  id: R_ID, title: 'לחזור לדייר', description: null, remind_at: '2026-10-07T09:00:00+03:00', status: 'pending',
  entity_type: null, entity_id: null, assigned_to: ASSIGNEE.id, created_by: CREATOR.id, category_id: null,
  completed_at: null, is_archived: false, created_at: '2026-10-06T08:00:00+03:00', updated_at: '2026-10-06T08:00:00+03:00',
  assigned_to_name: 'בית', created_by_name: 'אלף', category_name: null, category_color: null,
};

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  reminder: null as null | Record<string, unknown>,
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/userReminderAttachments', () => ({
  listReminderAttachments: vi.fn(async () => []),
  linkAttachments: vi.fn(async () => 0),
  toAttachmentView: (r: unknown) => r,
}));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    h.calls.push({ sql: flat, params });
    if (/from public\.user_reminders r/.test(flat)) return params[0] === R_ID ? h.reminder : null;
    if (/update public\.user_reminders set is_archived = true/.test(flat)) return h.reminder ? { id: R_ID } : null;
    if (/update public\.user_reminders set/.test(flat)) return h.reminder ? { ...h.reminder, ...(params.length > 1 ? {} : {}) } : null;
    throw new Error(`unexpected queryOne: ${flat}`);
  }),
}));

import { GET as LIST } from '@/app/api/user-reminders/route';
import { DELETE, GET, PATCH } from '@/app/api/user-reminders/[id]/route';
import { writeAudit } from '@/lib/db/audit';

const as = (user: typeof CREATOR | null) => { h.session = user ? { sid: 's', user } : null; };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const list = (qs = '') => LIST(new NextRequest(`http://localhost/api/user-reminders${qs}`));
const get = (id: string) => GET(new NextRequest(`http://localhost/api/user-reminders/${id}`), ctx(id));
const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/user-reminders/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), ctx(id));
const del = (id: string) => DELETE(new NextRequest(`http://localhost/api/user-reminders/${id}`, { method: 'DELETE' }), ctx(id));
const writes = () => h.calls.filter((c) => /^update public\.user_reminders/.test(c.sql));

beforeEach(() => {
  h.session = null;
  h.reminder = { ...REMINDER };
  h.calls = [];
  vi.mocked(writeAudit).mockClear();
});

describe('reminderRole / reminderPatchAllowed (pure)', () => {
  it('creator, assignee, nobody', () => {
    expect(reminderRole(CREATOR.id, REMINDER)).toBe('creator');
    expect(reminderRole(ASSIGNEE.id, REMINDER)).toBe('assignee');
    expect(reminderRole(STRANGER.id, REMINDER)).toBe('none');
  });
  it('a deleted creator (created_by null) is nobody — the assignee keeps the status write', () => {
    const orphan = { ...REMINDER, created_by: null };
    expect(reminderRole(CREATOR.id, orphan)).toBe('none');
    expect(reminderRole(ASSIGNEE.id, orphan)).toBe('assignee');
  });
  it('a reminder assigned to its own creator is the creator\'s', () => {
    expect(reminderRole(CREATOR.id, { ...REMINDER, assigned_to: CREATOR.id })).toBe('creator');
  });
  it('the creator may send anything; the assignee only status; nobody else anything', () => {
    expect(reminderPatchAllowed('creator', ['title', 'attachment_ids', 'is_archived'])).toBe(true);
    expect(reminderPatchAllowed('assignee', ['status'])).toBe(true);
    expect(reminderPatchAllowed('assignee', [])).toBe(true);
    expect(reminderPatchAllowed('assignee', ['status', 'title'])).toBe(false);
    expect(reminderPatchAllowed('assignee', ['is_archived'])).toBe(false);
    expect(reminderPatchAllowed('assignee', ['attachment_ids'])).toBe(false);
    expect(reminderPatchAllowed('none', ['status'])).toBe(false);
    expect(reminderPatchAllowed('none', [])).toBe(false);
  });
});

describe('GET /api/user-reminders — the session user\'s own set', () => {
  it('no session → 401', async () => {
    expect((await list()).status).toBe(401);
  });

  it('a client-sent involvingUser never reaches the query — the actor id does', async () => {
    as(CREATOR);
    const res = await list(`?involvingUser=${STRANGER.id}`);
    expect(res.status).toBe(200);
    const q = h.calls.find((c) => /from public\.user_reminders r/.test(c.sql));
    expect(q, 'the list query ran').toBeDefined();
    expect(q!.sql).toMatch(/\(r\.created_by = \$(\d+) or r\.assigned_to = \$\1\)/);
    expect(q!.params).toContain(CREATOR.id);
    expect(q!.params).not.toContain(STRANGER.id);
  });

  it('with no parameter at all the set is still bound to the actor — and sorted by the actor\'s own order', async () => {
    as(ASSIGNEE);
    expect((await list()).status).toBe(200);
    const q = h.calls.find((c) => /from public\.user_reminders r/.test(c.sql))!;
    // $1 = the involvement bound, $2 = the user whose drag order sorts the list: both the actor.
    expect(q.params).toEqual([ASSIGNEE.id, ASSIGNEE.id]);
    expect(q.sql).toMatch(/left join public\.user_reminder_order o on o\.reminder_id = r\.id and o\.user_id = \$2/);
    expect(q.sql).toMatch(/order by o\.position asc nulls last, r\.remind_at asc, r\.id asc/);
  });
});

describe('GET /api/user-reminders/[id]', () => {
  it('the creator and the assignee read it', async () => {
    as(CREATOR);
    expect((await get(R_ID)).status).toBe(200);
    as(ASSIGNEE);
    const res = await get(R_ID);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reminder: { id: string } }).reminder.id).toBe(R_ID);
  });

  it('anyone else gets the same 404 as a missing id — no body, no oracle', async () => {
    as(STRANGER);
    const foreign = await get(R_ID);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
    const missing = await get(MISSING);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });
});

describe('PATCH /api/user-reminders/[id]', () => {
  it('no session → 401; unknown id → 404', async () => {
    expect((await patch(R_ID, { status: 'done' })).status).toBe(401);
    as(CREATOR);
    expect((await patch(MISSING, { status: 'done' })).status).toBe(404);
  });

  it('the creator changes anything', async () => {
    as(CREATOR);
    const res = await patch(R_ID, { title: 'כותרת חדשה', status: 'done', is_archived: false });
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('the assignee marks it done — status alone', async () => {
    as(ASSIGNEE);
    const res = await patch(R_ID, { status: 'done' });
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].sql).toMatch(/set status = \$2/);
  });

  it.each([
    ['a title beside the status', { status: 'done', title: 'x' }],
    ['the title alone', { title: 'x' }],
    ['the assignment', { assigned_to: null }],
    ['the date', { remind_at: '2026-12-01T09:00:00+02:00' }],
    ['files', { status: 'done', attachment_ids: [] }],
    ['archiving', { is_archived: true }],
  ])('the assignee sending %s → 403, nothing written', async (_what, body) => {
    as(ASSIGNEE);
    const res = await patch(R_ID, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(writes()).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('a stranger → 403 even for the status, nothing written', async () => {
    as(STRANGER);
    const res = await patch(R_ID, { status: 'done' });
    expect(res.status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it('the role is checked before the body: a stranger with broken JSON is 403, not 400', async () => {
    as(STRANGER);
    expect((await patch(R_ID, '{not json')).status).toBe(403);
    as(CREATOR);
    expect((await patch(R_ID, '{not json')).status).toBe(400);
  });

  it('a reminder whose creator was deleted: the assignee still marks it done, nobody edits it', async () => {
    h.reminder = { ...REMINDER, created_by: null };
    as(ASSIGNEE);
    expect((await patch(R_ID, { status: 'done' })).status).toBe(200);
    expect((await patch(R_ID, { title: 'x' })).status).toBe(403);
    as(CREATOR);
    expect((await patch(R_ID, { title: 'x' })).status).toBe(403);
  });
});

describe('DELETE /api/user-reminders/[id]', () => {
  it('no session → 401; unknown id → 404', async () => {
    expect((await del(R_ID)).status).toBe(401);
    as(CREATOR);
    expect((await del(MISSING)).status).toBe(404);
  });

  it('the creator deletes', async () => {
    as(CREATOR);
    expect((await del(R_ID)).status).toBe(204);
    expect(writes()).toHaveLength(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it.each([['the assignee', ASSIGNEE], ['a stranger', STRANGER]])('%s → 403, nothing written', async (_who, user) => {
    as(user);
    const res = await del(R_ID);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(writes()).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

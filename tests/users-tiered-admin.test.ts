import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The tiered users-management model (decision 07/10/2026), through the REAL
// guard chain (requireAdmin → requireActor → getCurrentActor) and the real
// canManageRole / canGrantModule; only the session lookup, the pool, the
// audit writer and the mailer are fakes. What is locked:
//   • the matrix: an admin may not set the management tier (users /
//     permissions / settings) — neither in the side panel's PUT nor with an
//     invite's `permissions` — but finance / portal_* stay open; a super
//     admin may set everything;
//   • invites: an admin resends / cancels an invite to a role they manage
//     (manager / viewer / cleaner / maintenance), never one to admin /
//     super_admin; a super admin any; a manager none;
//   • PATCH: an admin moves a manager to viewer, never promotes, never
//     touches an admin; the last ACTIVE super admin cannot be demoted.

type Row = Record<string, unknown>;

const SUPER = { id: '11111111-1111-4111-8111-111111111111', username: 'ronen', email: 'r@x', full_name: 'רונן', role: 'super_admin' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', username: 'dana', email: 'd@x', full_name: 'דנה', role: 'admin' };
const MANAGER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_SUPER_ID = '55555555-5555-4555-8555-555555555555';

const userRow = (id: string, role: string, over: Row = {}): Row => ({
  id, username: id.slice(0, 4), email: `${id.slice(0, 4)}@x`, full_name: `user ${role}`, role,
  is_active: true, allow_google_auth: false, notification_phone: null, created_at: '2026-01-01', ...over,
});

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  users: new Map<string, Record<string, unknown>>(),
  invite: null as null | { id: string; email: string; full_name: string; role: string; accepted_at: string | null },
  remainingSuperAdmins: 1,
  writes: [] as string[],
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/services/email', () => ({ sendUserInviteEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/config', () => ({ appUrl: () => 'http://localhost' }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^select module, can_view, can_edit from public\.user_permissions/.test(s)) return { rows: [], rowCount: 0 };
    h.writes.push(s);
    if (/^insert into public\.user_invites/.test(s)) return { rows: [{ id: 'inv-new' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/from public\.users\s+where id = \$1/.test(sql)) return h.users.get(params[0] as string) ?? null;
    if (/role = 'super_admin' and is_active = true and id <> \$1/.test(sql)) return { count: h.remainingSuperAdmins };
    if (/from public\.user_invites\s+where id = \$1/.test(sql)) return params[0] === h.invite?.id ? h.invite : null;
    if (/exists/i.test(sql)) return { exists: false };
    throw new Error(`unexpected queryOne: ${sql}`);
  }),
  withTransaction: vi.fn(async (fn: (c: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) =>
    fn({ query: async (sql: string) => { h.writes.push(sql.replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 1 }; } })),
}));

import { PUT as putPermission } from '@/app/api/users/[id]/permissions/route';
import { POST as createUser } from '@/app/api/users/route';
import { PATCH as patchUser } from '@/app/api/users/[id]/route';
import { DELETE as cancelInvite } from '@/app/api/invites/[id]/route';
import { POST as resendInvite } from '@/app/api/invites/[id]/resend/route';
import { sendUserInviteEmail } from '@/services/email';

const as = (u: { id: string; username: string; email: string; full_name: string; role: string }, role = u.role) => {
  h.session = { sid: 's', user: { ...u, role } };
};
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.session = null;
  h.users = new Map([
    [SUPER.id, userRow(SUPER.id, 'super_admin')],
    [ADMIN.id, userRow(ADMIN.id, 'admin')],
    [MANAGER_ID, userRow(MANAGER_ID, 'manager')],
    [OTHER_ADMIN_ID, userRow(OTHER_ADMIN_ID, 'admin')],
    [SECOND_SUPER_ID, userRow(SECOND_SUPER_ID, 'super_admin')],
  ]);
  h.invite = null;
  h.remainingSuperAdmins = 1;
  h.writes = [];
  vi.mocked(sendUserInviteEmail).mockClear();
});

describe('PUT /api/users/[id]/permissions — the management tier', () => {
  const put = (module: string, can_view = true) =>
    putPermission(json(`http://x/api/users/${MANAGER_ID}/permissions`, 'PUT', { module, can_view, can_edit: false }), ctx(MANAGER_ID));

  it.each(['users_management', 'roles_management', 'settings'])('admin → %s: 403, nothing written — grant or revoke', async (module) => {
    as(ADMIN);
    expect((await put(module, true)).status).toBe(403);
    expect((await put(module, false)).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it.each(['finance', 'portal_manage', 'portal_decisions', 'dashboard'])('admin → %s: allowed (finance / portal stay open)', async (module) => {
    as(ADMIN);
    expect((await put(module)).status).toBe(200);
    expect(h.writes.some((s) => s.startsWith('insert into public.user_permissions'))).toBe(true);
  });

  it('super_admin → settings / users_management: allowed', async () => {
    as(SUPER);
    expect((await put('settings')).status).toBe(200);
    expect((await put('users_management')).status).toBe(200);
  });

  it('admin on an admin\'s matrix → 403 (the role scope comes first)', async () => {
    as(ADMIN);
    const res = await putPermission(
      json(`http://x/api/users/${OTHER_ADMIN_ID}/permissions`, 'PUT', { module: 'dashboard', can_view: true, can_edit: false }),
      ctx(OTHER_ADMIN_ID),
    );
    expect(res.status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });
});

describe('POST /api/users — an invite\'s permissions follow the same rule', () => {
  const invite = (permissions: unknown[]) =>
    createUser(json('http://x/api/users', 'POST', { email: 'new@x.co', full_name: 'משתמש חדש', role: 'manager', permissions }));

  it('admin granting settings with an invite → 403, no invite row, no email', async () => {
    as(ADMIN);
    const res = await invite([{ module: 'settings', can_view: true, can_edit: false }]);
    expect(res.status).toBe(403);
    expect(h.writes).toHaveLength(0);
    expect(sendUserInviteEmail).not.toHaveBeenCalled();
  });

  it('admin with finance granted and the management rows left false → 201', async () => {
    as(ADMIN);
    const res = await invite([
      { module: 'finance', can_view: true, can_edit: false },
      { module: 'users_management', can_view: false, can_edit: false },
      { module: 'settings', can_view: false, can_edit: false },
    ]);
    expect(res.status).toBe(201);
    expect(h.writes.some((s) => s.startsWith('insert into public.user_invites'))).toBe(true);
  });

  it('super_admin granting settings with an invite → 201', async () => {
    as(SUPER);
    expect((await invite([{ module: 'settings', can_view: true, can_edit: true }])).status).toBe(201);
  });
});

describe('invites — resend / cancel within the actor\'s scope', () => {
  const open = (role: string) => ({ id: 'inv-1', email: 'i@x.co', full_name: 'מוזמן', role, accepted_at: null });
  const cancel = () => cancelInvite(new NextRequest('http://x/api/invites/inv-1', { method: 'DELETE' }), ctx('inv-1'));
  const resend = () => resendInvite(new NextRequest('http://x/api/invites/inv-1/resend', { method: 'POST' }), ctx('inv-1'));

  it.each(['manager', 'viewer', 'cleaner', 'maintenance'])('admin, invite to %s → resend 200 + cancel 200', async (role) => {
    as(ADMIN);
    h.invite = open(role);
    expect((await resend()).status).toBe(200);
    expect(sendUserInviteEmail).toHaveBeenCalledTimes(1);
    expect((await cancel()).status).toBe(200);
    expect(h.writes.some((s) => s.startsWith('delete from public.user_invites'))).toBe(true);
  });

  it.each(['admin', 'super_admin'])('admin, invite to %s → 403 on both, nothing touched', async (role) => {
    as(ADMIN);
    h.invite = open(role);
    expect((await resend()).status).toBe(403);
    expect((await cancel()).status).toBe(403);
    expect(h.writes).toHaveLength(0);
    expect(sendUserInviteEmail).not.toHaveBeenCalled();
  });

  it('super_admin, invite to admin → resend 200 + cancel 200', async () => {
    as(SUPER);
    h.invite = open('admin');
    expect((await resend()).status).toBe(200);
    expect((await cancel()).status).toBe(200);
  });

  it('manager → 403; no session → 401', async () => {
    h.invite = open('viewer');
    expect((await cancel()).status).toBe(401);
    as(ADMIN, 'manager');
    expect((await resend()).status).toBe(403);
    expect((await cancel()).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });
});

describe('PATCH /api/users/[id] — role changes in the tiered model', () => {
  const patch = (id: string, body: Row) => patchUser(json(`http://x/api/users/${id}`, 'PATCH', body), ctx(id));

  it('admin moves a manager to viewer → 200', async () => {
    as(ADMIN);
    expect((await patch(MANAGER_ID, { role: 'viewer' })).status).toBe(200);
  });

  it('admin promotes a manager to admin / super_admin → 403', async () => {
    as(ADMIN);
    expect((await patch(MANAGER_ID, { role: 'admin' })).status).toBe(403);
    expect((await patch(MANAGER_ID, { role: 'super_admin' })).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('admin touches another admin, or their own row → 403', async () => {
    as(ADMIN);
    expect((await patch(OTHER_ADMIN_ID, { is_active: false })).status).toBe(403);
    expect((await patch(ADMIN.id, { role: 'manager' })).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('the last ACTIVE super admin cannot be demoted or disabled; with another one it can', async () => {
    as(SUPER);
    h.remainingSuperAdmins = 0;
    const demote = await patch(SECOND_SUPER_ID, { role: 'admin' });
    expect(demote.status).toBe(403);
    expect(((await demote.json()) as { error: string }).error).toMatch(/הסופר אדמין האחרון/);
    expect((await patch(SECOND_SUPER_ID, { is_active: false })).status).toBe(403);
    expect(h.writes).toHaveLength(0);

    h.remainingSuperAdmins = 1;
    expect((await patch(SECOND_SUPER_ID, { role: 'admin' })).status).toBe(200);
  });
});

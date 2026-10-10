import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ROLE_DEFAULTS, isMatrixRole, type Role } from '@/lib/permissions/constants';

// Role changes in /settings/users — Ronen's model of 10/10/2026, through the
// REAL guard chain (requireAdmin → requireActor → getCurrentActor) and the
// real PATCH / PUT handlers; only the session lookup, the pool and the audit
// writer are fakes. What is locked:
//   • the full table: every editor role × every target role × every new
//     role. super_admin — everyone; admin — only the roles below it, and only
//     into a role below it; every other role — nobody;
//   • a move to cleaner / maintenance saves (until 10/10 PATCH answered 400
//     "תפקיד לא תקין" to both, while the panel offered them);
//   • a saved change rewrites the role, re-seeds the matrix of the new role,
//     ends the user's sessions and writes one audit row: who, from → to;
//   • nobody changes their own role, and the last active super admin is
//     never demoted or disabled;
//   • a worker's matrix saves like a manager's (PUT answered 400 to workers).

type Row = Record<string, unknown>;
type Write = { sql: string; params: unknown[] };

const ROLES: readonly Role[] = ['super_admin', 'admin', 'manager', 'viewer', 'cleaner', 'maintenance'];
const BELOW_ADMIN: ReadonlySet<Role> = new Set<Role>(['manager', 'viewer', 'cleaner', 'maintenance']);

/** The model, written out — deliberately NOT derived from canManageRole. */
function verdict(actor: Role, target: Role, next: Role): 200 | 403 {
  if (actor === 'super_admin') return 200;
  if (actor === 'admin') return BELOW_ADMIN.has(target) && BELOW_ADMIN.has(next) ? 200 : 403;
  return 403;
}

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const userRow = (id: string, role: Role, over: Row = {}): Row => ({
  id, username: id.slice(0, 4), email: `${id.slice(0, 4)}@x`, full_name: `user ${role}`, role,
  is_active: true, allow_google_auth: false, notification_phone: null, created_at: '2026-01-01', ...over,
});

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  users: new Map<string, Record<string, unknown>>(),
  remainingSuperAdmins: 1,
  writes: [] as { sql: string; params: unknown[] }[],
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock('@/lib/db/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@/lib/db', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^select module, can_view, can_edit from public\.user_permissions/.test(s)) return { rows: [], rowCount: 0 };
    h.writes.push({ sql: s, params });
    return { rows: [], rowCount: 1 };
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/from public\.users\s+where id = \$1/.test(sql)) return h.users.get(params[0] as string) ?? null;
    if (/role = 'super_admin' and is_active = true and id <> \$1/.test(sql)) return { count: h.remainingSuperAdmins };
    throw new Error(`unexpected queryOne: ${sql}`);
  }),
  withTransaction: vi.fn(async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        h.writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rows: [], rowCount: 1 };
      },
    })),
}));

import { PATCH } from '@/app/api/users/[id]/route';
import { PUT as putPermission } from '@/app/api/users/[id]/permissions/route';
import { writeAudit } from '@/lib/db/audit';

const actingAs = (role: Role, id = ACTOR_ID) => {
  h.session = { sid: 's', user: { id, username: 'actor', email: 'actor@x', full_name: 'העורך', role } };
};
const patch = (id: string, body: Row) =>
  PATCH(new NextRequest(`http://x/api/users/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const writesMatching = (rx: RegExp): Write[] => h.writes.filter((w) => rx.test(w.sql));

beforeEach(() => {
  h.session = null;
  h.users = new Map();
  h.remainingSuperAdmins = 1;
  h.writes = [];
  vi.mocked(writeAudit).mockClear();
});

describe('PATCH role — the whole table: editor × target × new role', () => {
  const cases = ROLES.flatMap((actor) =>
    ROLES.flatMap((target) => ROLES.map((next) => [actor, target, next, verdict(actor, target, next)] as const)),
  );

  it.each(cases)('%s moves a %s to %s → %i', async (actor, target, next, status) => {
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, actor));
    h.users.set(TARGET_ID, userRow(TARGET_ID, target));
    actingAs(actor);

    const res = await patch(TARGET_ID, { role: next });
    expect(res.status).toBe(status);

    if (status === 403) {
      expect(h.writes).toHaveLength(0);
      expect(writeAudit).not.toHaveBeenCalled();
      return;
    }
    const [update] = writesMatching(/^update public\.users set /);
    expect(update?.params[1]).toBe(next);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAudit).mock.calls[0]![0]).toMatchObject({
      actorUserId: ACTOR_ID, action: 'updated', entityType: 'user', entityId: TARGET_ID,
      changes: { before: { role: target }, after: { role: next } },
      metadata: { roleChanged: next !== target, actor_role: actor },
    });
  });
});

describe('PATCH role — what a saved change does', () => {
  it('the reported case: a manager moved to maintenance saves, gets the worker matrix, is logged out', async () => {
    for (const actor of ['super_admin', 'admin'] as const) {
      h.writes = [];
      vi.mocked(writeAudit).mockClear();
      h.users.set(ACTOR_ID, userRow(ACTOR_ID, actor));
      h.users.set(TARGET_ID, userRow(TARGET_ID, 'manager'));
      actingAs(actor);

      const res = await patch(TARGET_ID, { role: 'maintenance' });
      expect(res.status, actor).toBe(200);
      expect(writesMatching(/^update public\.users set /)[0]?.params[1]).toBe('maintenance');
      expect(writesMatching(/^delete from public\.user_permissions/)).toHaveLength(1);
      const seeded = writesMatching(/^insert into public\.user_permissions/).map((w) => w.params.slice(1));
      expect(seeded).toEqual(ROLE_DEFAULTS.maintenance!.map((p) => [p.module, p.canView, p.canEdit]));
      expect(writesMatching(/^delete from public\.sessions where user_id = \$1/)[0]?.params).toEqual([TARGET_ID]);
    }
  });

  it('maintenance ↔ cleaner (between the field departments) saves both ways', async () => {
    actingAs('admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'maintenance'));
    expect((await patch(TARGET_ID, { role: 'cleaner' })).status).toBe(200);
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'cleaner'));
    expect((await patch(TARGET_ID, { role: 'maintenance' })).status).toBe(200);
  });

  it('into admin (super admin only): the matrix rows go, nothing is seeded', async () => {
    actingAs('super_admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'super_admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'maintenance'));
    expect((await patch(TARGET_ID, { role: 'admin' })).status).toBe(200);
    expect(writesMatching(/^delete from public\.user_permissions/)).toHaveLength(1);
    expect(writesMatching(/^insert into public\.user_permissions/)).toHaveLength(0);
  });

  it('a save without a role change keeps the matrix and the sessions', async () => {
    actingAs('admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'maintenance'));
    expect((await patch(TARGET_ID, { full_name: 'שם חדש' })).status).toBe(200);
    expect(writesMatching(/user_permissions|sessions/)).toHaveLength(0);
    expect(vi.mocked(writeAudit).mock.calls[0]![0]).toMatchObject({ metadata: { roleChanged: false } });
  });

  it('the admin\'s refusals say why', async () => {
    actingAs('admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'admin'));
    expect(await errorOf(await patch(TARGET_ID, { role: 'manager' }))).toBe('אין הרשאה לנהל משתמש בתפקיד זה');
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'manager'));
    expect(await errorOf(await patch(TARGET_ID, { role: 'admin' }))).toBe('אין הרשאה להקצות תפקיד זה');
  });

  it('not a role → 400; no session → 401', async () => {
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'manager'));
    expect((await patch(TARGET_ID, { role: 'manager' })).status).toBe(401);
    actingAs('super_admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'super_admin'));
    const res = await patch(TARGET_ID, { role: 'owner' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('תפקיד לא תקין');
    expect(h.writes).toHaveLength(0);
  });
});

describe('PATCH role — yourself and the last super admin', () => {
  it.each(['super_admin', 'admin'] as const)('a %s cannot change their own role or disable themselves', async (role) => {
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, role));
    actingAs(role);
    for (const next of ROLES.filter((r) => r !== role)) {
      expect((await patch(ACTOR_ID, { role: next })).status, next).toBe(403);
    }
    expect((await patch(ACTOR_ID, { is_active: false })).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('a super admin\'s own refusal names the rule', async () => {
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'super_admin'));
    actingAs('super_admin');
    expect(await errorOf(await patch(ACTOR_ID, { role: 'admin' }))).toBe('אסור לשנות תפקיד של עצמך');
  });

  it('the last ACTIVE super admin is never demoted or disabled — with another one, it is', async () => {
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'super_admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'super_admin'));
    actingAs('super_admin');
    h.remainingSuperAdmins = 0;
    for (const next of ROLES.filter((r) => r !== 'super_admin')) {
      const res = await patch(TARGET_ID, { role: next });
      expect(res.status, next).toBe(403);
      expect(await errorOf(res)).toMatch(/הסופר אדמין האחרון/);
    }
    expect((await patch(TARGET_ID, { is_active: false })).status).toBe(403);
    expect(h.writes).toHaveLength(0);

    h.remainingSuperAdmins = 1;
    expect((await patch(TARGET_ID, { role: 'manager' })).status).toBe(200);
  });
});

describe('PUT /api/users/[id]/permissions — every matrix role, the worker too', () => {
  const put = (id: string, module: string) =>
    putPermission(new NextRequest(`http://x/api/users/${id}/permissions`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module, can_view: true, can_edit: false }),
    }), { params: Promise.resolve({ id }) });

  it.each(ROLES.filter(isMatrixRole))('admin toggles a module in a %s\'s matrix → 200', async (role) => {
    actingAs('admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, role));
    expect((await put(TARGET_ID, 'issues')).status).toBe(200);
    expect(writesMatching(/^insert into public\.user_permissions/)).toHaveLength(1);
  });

  it('the management tier stays the super admin\'s, on a worker too', async () => {
    actingAs('admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'maintenance'));
    expect((await put(TARGET_ID, 'users_management')).status).toBe(403);
    expect(h.writes).toHaveLength(0);
  });

  it('a role without a matrix (admin) → 400, nothing written', async () => {
    actingAs('super_admin');
    h.users.set(ACTOR_ID, userRow(ACTOR_ID, 'super_admin'));
    h.users.set(TARGET_ID, userRow(TARGET_ID, 'admin'));
    expect((await put(TARGET_ID, 'issues')).status).toBe(400);
    expect(h.writes).toHaveLength(0);
  });
});

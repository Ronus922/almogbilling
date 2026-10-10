import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { requireSeededAdmin } from './db-fixtures';
import { DEFAULT_MANAGER, DEFAULT_WORKER, type ModulePermission } from '@/lib/permissions/constants';

// Roles in /settings/users against a REAL database (10/10/2026). The routes
// run as in production; only the session lookup, the mailer, the invite
// token generator and the rate limiter are fakes (the last so no bucket row
// is left behind). What is proved on real rows:
//   • a new maintenance worker STAYS one — by direct create and by invite +
//     accept: users.role, the worker matrix, and an audit row naming the
//     role and who chose it (the 09/10 user arrived as a manager);
//   • an admin moves a manager to maintenance and on to cleaner: the role,
//     the worker matrix in place of the manager's, the sessions gone, and
//     an audit row per change with who, from → to, when;
//   • an admin is refused an admin and a super admin (403, nothing changes);
//   • the last ACTIVE super admin is counted on real rows — a disabled one
//     does not count.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Every row it creates is removed by the exact id it recorded (CLAUDE.md
// iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  token: '',
}));

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(async () => h.session),
  createSession: vi.fn(async () => undefined),
}));
vi.mock('@/lib/auth/rateLimit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
  clientIp: () => 'test',
}));
vi.mock('@/services/email', () => ({ sendUserInviteEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/inviteTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/inviteTokens')>()),
  generateInviteToken: () => h.token,
}));

const { POST: createUser } = await import('@/app/api/users/route');
const { PATCH: patchUser } = await import('@/app/api/users/[id]/route');
const { POST: acceptInvite } = await import('@/app/api/auth/accept-invite/route');

const uniq = `urole-${Date.now()}`;
const PASSWORD = 'Urole-Temp0rary!';

interface UserRow { id: string; username: string; email: string; full_name: string | null; role: string }
let superAdmin: UserRow;
let admin: UserRow;

/** Everything created, by exact id. */
const made = { users: [] as string[], invites: [] as string[], sessions: [] as string[], audit: [] as string[] };

async function makeUser(role: string, suffix: string, active = true): Promise<UserRow> {
  const r = await pool.query<UserRow>(
    `insert into public.users (username, email, password_hash, full_name, role, is_active)
     values ($1, $2, 'not-a-hash', $3, $4, $5) returning id, username, email, full_name, role`,
    [`${uniq}-${suffix}`, `${uniq}-${suffix}@billing.local`, `משתמש ${suffix} ${uniq}`, role, active],
  );
  made.users.push(r.rows[0]!.id);
  return r.rows[0]!;
}

async function seedMatrix(userId: string, perms: ModulePermission[]) {
  for (const p of perms) {
    await pool.query(
      `insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, $3, $4)`,
      [userId, p.module, p.canView, p.canEdit],
    );
  }
}

const matrixOf = async (userId: string) =>
  (await pool.query<{ module: string; can_view: boolean; can_edit: boolean }>(
    `select module, can_view, can_edit from public.user_permissions where user_id = $1 order by module`, [userId],
  )).rows.map((r) => ({ module: r.module, canView: r.can_view, canEdit: r.can_edit }));
const sorted = (perms: ModulePermission[]) => [...perms].sort((a, b) => a.module.localeCompare(b.module));
const roleOf = async (id: string) => (await pool.query<{ role: string }>(`select role from public.users where id = $1`, [id])).rows[0]?.role;

/** The audit rows this test caused for an entity, oldest first; recorded for cleanup. */
async function auditFor(entityId: string) {
  const r = await pool.query<{ id: string; action: string; entity_type: string; actor_user_id: string | null; actor_name: string | null; changes: { before?: { role?: string }; after?: { role?: string } } | null; metadata: Record<string, unknown> | null; created_at: Date }>(
    `select id, action, entity_type, actor_user_id, actor_name, changes, metadata, created_at
       from public.audit_log where entity_id = $1 order by created_at, id`, [entityId],
  );
  for (const row of r.rows) if (!made.audit.includes(row.id)) made.audit.push(row.id);
  return r.rows;
}

const as = (u: UserRow) => { h.session = { sid: 's', user: { id: u.id, username: u.username, email: u.email, full_name: u.full_name, role: u.role } }; };
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (id: string, body: Record<string, unknown>) =>
  patchUser(json(`http://localhost/api/users/${id}`, 'PATCH', body), { params: Promise.resolve({ id }) });

d('roles in /settings/users on a real database', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const superId = await requireSeededAdmin(pool);
    superAdmin = (await pool.query<UserRow>(`select id, username, email, full_name, role from public.users where id = $1`, [superId])).rows[0]!;
    admin = await makeUser('admin', 'admin');
  });

  afterAll(async () => {
    for (const id of made.audit) await pool.query(`delete from public.audit_log where id = $1`, [id]);
    for (const id of made.sessions) await pool.query(`delete from public.sessions where id = $1`, [id]);
    for (const id of made.invites) await pool.query(`delete from public.user_invites where id = $1`, [id]);
    for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
    await pool.end();
  });

  it('a maintenance worker created directly by an admin is saved as maintenance', async () => {
    as(admin);
    const res = await createUser(json('http://localhost/api/users', 'POST', {
      email: `${uniq}-direct@billing.local`, full_name: `עובד אחזקה ישיר ${uniq}`, role: 'maintenance', password: PASSWORD,
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; role: string };
    made.users.push(body.id);
    expect(body.role).toBe('maintenance');

    expect(await roleOf(body.id)).toBe('maintenance');
    expect(await matrixOf(body.id)).toEqual(sorted(DEFAULT_WORKER));
    const [created] = await auditFor(body.id);
    expect(created).toMatchObject({ action: 'created', entity_type: 'user', actor_user_id: admin.id });
    expect(created!.metadata).toMatchObject({ role: 'maintenance', method: 'password', actor_role: 'admin' });
  });

  it('a maintenance worker invited by an admin is still maintenance after accepting', async () => {
    as(admin);
    h.token = `${uniq}-token-0123456789abcdef`;
    const email = `${uniq}-invite@billing.local`;
    const res = await createUser(json('http://localhost/api/users', 'POST', {
      email, full_name: `עובד אחזקה מוזמן ${uniq}`, role: 'maintenance',
    }));
    expect(res.status).toBe(201);
    const invite = (await res.json()) as { id: string; role: string };
    made.invites.push(invite.id);
    expect(invite.role).toBe('maintenance');
    const stored = await pool.query<{ role: string }>(`select role from public.user_invites where id = $1`, [invite.id]);
    expect(stored.rows[0]?.role).toBe('maintenance');
    const [inviteAudit] = await auditFor(invite.id);
    expect(inviteAudit).toMatchObject({ action: 'created', entity_type: 'user_invite', actor_user_id: admin.id });
    expect(inviteAudit!.metadata).toMatchObject({ role: 'maintenance' });

    h.session = null; // the invitee is not logged in
    const accepted = await acceptInvite(new Request('http://localhost/api/auth/accept-invite', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: h.token, password: PASSWORD }),
    }));
    expect(accepted.status).toBe(200);
    const user = await pool.query<{ id: string; role: string }>(`select id, role from public.users where lower(email) = $1`, [email]);
    made.users.push(user.rows[0]!.id);
    expect(user.rows[0]?.role).toBe('maintenance');
    expect(await matrixOf(user.rows[0]!.id)).toEqual(sorted(DEFAULT_WORKER));

    const [created] = await auditFor(user.rows[0]!.id);
    expect(created).toMatchObject({ action: 'created', entity_type: 'user', actor_user_id: admin.id });
    expect(created!.metadata).toMatchObject({ role: 'maintenance', method: 'invite', invite_id: invite.id });
  });

  it('an admin moves a manager to maintenance, then on to cleaner — each change saved and logged', async () => {
    const worker = await makeUser('manager', 'mover');
    await seedMatrix(worker.id, DEFAULT_MANAGER);
    const sid = `${uniq}-sid`;
    await pool.query(
      `insert into public.sessions (id, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`,
      [sid, worker.id],
    );
    made.sessions.push(sid);

    as(admin);
    const before = Date.now();
    const toMaintenance = await patch(worker.id, { role: 'maintenance' });
    expect(toMaintenance.status).toBe(200);
    expect(((await toMaintenance.json()) as { user: { role: string } }).user.role).toBe('maintenance');
    expect(await roleOf(worker.id)).toBe('maintenance');
    expect(await matrixOf(worker.id)).toEqual(sorted(DEFAULT_WORKER));
    expect((await pool.query(`select 1 from public.sessions where user_id = $1`, [worker.id])).rowCount).toBe(0);

    expect((await patch(worker.id, { role: 'cleaner' })).status).toBe(200);
    expect(await roleOf(worker.id)).toBe('cleaner');
    expect(await matrixOf(worker.id)).toEqual(sorted(DEFAULT_WORKER));

    const changes = (await auditFor(worker.id)).filter((r) => r.action === 'updated');
    expect(changes.map((r) => [r.changes?.before?.role, r.changes?.after?.role])).toEqual([
      ['manager', 'maintenance'],
      ['maintenance', 'cleaner'],
    ]);
    for (const row of changes) {
      expect(row.actor_user_id).toBe(admin.id);
      expect(row.actor_name).toBe(admin.full_name);
      expect(row.metadata).toMatchObject({ roleChanged: true, actor_role: 'admin' });
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    }
  });

  it('an admin is refused an admin and a super admin — nothing changes', async () => {
    const otherAdmin = await makeUser('admin', 'other-admin');
    as(admin);
    for (const [target, role] of [[otherAdmin.id, 'manager'], [superAdmin.id, 'admin']] as const) {
      const res = await patch(target, { role });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('אין הרשאה לנהל משתמש בתפקיד זה');
    }
    expect(await roleOf(otherAdmin.id)).toBe('admin');
    expect(await roleOf(superAdmin.id)).toBe('super_admin');
    expect(await auditFor(otherAdmin.id)).toHaveLength(0);
  });

  it('the last ACTIVE super admin, counted on real rows: a disabled one does not count', async () => {
    const others = await pool.query<{ c: number }>(
      `select count(*)::int as c from public.users where role = 'super_admin' and is_active and id <> $1`, [superAdmin.id],
    );
    expect(others.rows[0]?.c, 'precondition: the seeded e2e-admin is the only active super admin').toBe(0);

    const dormant = await makeUser('super_admin', 'dormant-super', false);
    as(dormant); // a session as the disabled super admin: the guard reads the session, the count reads the table
    const res = await patch(superAdmin.id, { role: 'admin' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/הסופר אדמין האחרון/);
    expect(await roleOf(superAdmin.id)).toBe('super_admin');

    // With the seeded super admin still active, demoting another one is allowed.
    const second = await makeUser('super_admin', 'second-super');
    as(superAdmin);
    expect((await patch(second.id, { role: 'admin' })).status).toBe(200);
    expect(await roleOf(second.id)).toBe('admin');
    await auditFor(second.id);
  });
});

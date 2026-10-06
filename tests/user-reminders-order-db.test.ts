import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { requireSeededAdmin } from './db-fixtures';

// The per-user order of the reminders list on a REAL database (06/10/2026):
// PUT /api/user-reminders/order as in production (guard → setUserReminderOrder
// → one transaction) and GET /api/user-reminders sorted by it; only the
// session lookup is a fake. What is proved on real rows:
//   • the seeded e2e-admin and a second user share two reminders; the admin's
//     drag writes the admin's rows alone, the second user's list keeps the
//     default order (remind_at) — and the other way round;
//   • the list: placed ones first by position, the rest after by remind_at;
//   • a reminder of the other user → 403 and no row; an unknown id → 404;
//   • the rows go with their reminder and with their user (ON DELETE CASCADE).
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Every row it creates is removed by the exact id it recorded (iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
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
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => h.session) }));

const { PUT } = await import('@/app/api/user-reminders/order/route');
const { GET } = await import('@/app/api/user-reminders/route');
const { createUserReminder } = await import('@/lib/db/userReminders');

const uniq = `uord-${Date.now()}`;

interface User { id: string; username: string; email: string; full_name: string | null; role: string }
let admin: User;
let other: User;
const made = { reminders: [] as string[], users: [] as string[] };

const as = (u: User) => { h.session = { sid: 's', user: u }; };
const put = (ids: string[]) =>
  PUT(new NextRequest('http://localhost/api/user-reminders/order', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  }));
/** This file's reminders as the list route returns them for the session user, top to bottom. */
async function listed(): Promise<string[]> {
  const res = await GET(new NextRequest('http://localhost/api/user-reminders'));
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: Array<{ id: string; position: number | null }> };
  return items.map((r) => r.id).filter((id) => made.reminders.includes(id));
}
async function rowsOf(userId: string): Promise<Array<[string, number]>> {
  const r = await pool.query<{ reminder_id: string; position: number }>(
    `select reminder_id, position from public.user_reminder_order where user_id = $1 and reminder_id = any($2::uuid[]) order by position, reminder_id`,
    [userId, made.reminders],
  );
  return r.rows.map((x) => [x.reminder_id, x.position]);
}

let A = ''; let B = ''; let C = ''; // A, B: admin's, shared with `other`; C: admin's alone

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_URL, max: 3 });
  pool.on('error', () => undefined);
  const adminId = await requireSeededAdmin(pool);
  const a = await pool.query<User>(`select id, username, email, full_name, role from public.users where id = $1`, [adminId]);
  admin = a.rows[0];
  const o = await pool.query<User>(
    `insert into public.users (username, email, password_hash, full_name, role, is_active)
     values ($1, $2, 'not-a-hash', $3, 'super_admin', true) returning id, username, email, full_name, role`,
    [`${uniq}-other`, `${uniq}-other@billing.local`, `משתמש אחר ${uniq}`],
  );
  other = o.rows[0];
  made.users.push(other.id);
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  A = (await createUserReminder({ title: `${uniq} A`, remind_at: at(1), assigned_to: other.id }, admin.id)).id;
  B = (await createUserReminder({ title: `${uniq} B`, remind_at: at(2), assigned_to: other.id }, admin.id)).id;
  C = (await createUserReminder({ title: `${uniq} C`, remind_at: at(3) }, admin.id)).id;
  made.reminders.push(A, B, C);
});

afterAll(async () => {
  for (const id of made.reminders) await pool.query(`delete from public.user_reminders where id = $1`, [id]);
  for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
  await pool.end();
});

d('PUT /api/user-reminders/order on a real database', () => {
  it('before any drag both lists are by remind_at, with no position', async () => {
    as(admin);
    expect(await listed()).toEqual([A, B, C]);
    as(other);
    expect(await listed()).toEqual([A, B]);
    expect(await rowsOf(admin.id)).toEqual([]);
  });

  it('the admin\'s drag writes the admin\'s rows alone; the other user\'s list does not move', async () => {
    as(admin);
    expect((await put([C, A, B])).status).toBe(200);
    expect(await rowsOf(admin.id)).toEqual([[C, 0], [A, 1], [B, 2]]);
    expect(await rowsOf(other.id)).toEqual([]);
    expect(await listed()).toEqual([C, A, B]);
    as(other);
    expect(await listed()).toEqual([A, B]);
  });

  it('the other user\'s drag writes their rows alone; the admin keeps theirs', async () => {
    as(other);
    expect((await put([B, A])).status).toBe(200);
    expect(await rowsOf(other.id)).toEqual([[B, 0], [A, 1]]);
    expect(await listed()).toEqual([B, A]);
    as(admin);
    expect(await rowsOf(admin.id)).toEqual([[C, 0], [A, 1], [B, 2]]);
    expect(await listed()).toEqual([C, A, B]);
  });

  it('a dragged subset re-places those ids only; an undragged reminder sorts after the placed ones', async () => {
    as(admin);
    const D = (await createUserReminder({ title: `${uniq} D`, remind_at: new Date(Date.now() + 60_000).toISOString() }, admin.id)).id;
    made.reminders.push(D);
    // D is the soonest, yet it has no row: after C, A, B.
    expect(await listed()).toEqual([C, A, B, D]);
    expect((await put([B, C])).status).toBe(200);
    // B 0, C 1 rewritten; A keeps its 1 — ties are listed by id here.
    expect(await rowsOf(admin.id)).toEqual([[B, 0], ...[A, C].sort().map((id): [string, number] => [id, 1])]);
    // A (1) and C (1) tie: remind_at decides (A sooner), then D (no row).
    expect(await listed()).toEqual([B, A, C, D]);
  });

  it('someone else\'s reminder → 403 and no row; an unknown id → 404', async () => {
    as(other);
    const before = await rowsOf(other.id);
    expect((await put([C])).status).toBe(403);
    expect((await put([A, C])).status).toBe(403);
    expect((await put([A, '00000000-0000-4000-8000-00000000dead'])).status).toBe(404);
    expect(await rowsOf(other.id)).toEqual(before);
  });

  it('the rows go with their reminder and with their user', async () => {
    const r = await pool.query<{ n: string }>(`select count(*)::text as n from public.user_reminder_order where reminder_id = $1`, [B]);
    expect(Number(r.rows[0].n)).toBe(2);
    await pool.query(`delete from public.user_reminders where id = $1`, [B]);
    made.reminders.splice(made.reminders.indexOf(B), 1);
    const gone = await pool.query(`select 1 from public.user_reminder_order where reminder_id = $1`, [B]);
    expect(gone.rowCount).toBe(0);

    expect((await rowsOf(other.id)).length).toBeGreaterThan(0);
    await pool.query(`delete from public.users where id = $1`, [other.id]);
    made.users.splice(made.users.indexOf(other.id), 1);
    expect(await rowsOf(other.id)).toEqual([]);
  });
});

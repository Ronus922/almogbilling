import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { requireSeededAdmin } from './db-fixtures';
import { DEFAULT_MANAGER, DEFAULT_VIEWER } from '@/lib/permissions/constants';

// The debtors table's bulk legal-status change against a REAL database
// (PUT /api/debtors/legal-status/bulk). Proved on real rows:
//   • per apartment exactly what the single route writes — legal_status_id,
//     source MANUAL, updated_at/by/by_name — plus ONE legal_status_history row
//     EACH with the old/new snapshot and the actor;
//   • an apartment already on the target status is skipped (no row, no mail line);
//   • ONE consolidated mail for the whole action, to the status's addresses (and
//     the lawyer from Settings when the status is a legal one); a failing mail
//     never undoes the change;
//   • all or nothing: a missing apartment, an inactive status, and a write that
//     fails halfway (a trigger raising on one row) leave no row and no history
//     changed;
//   • admin and super admin only — a manager holding status_management:edit, a
//     viewer and a missing session are refused and nothing changes.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Every row it creates is removed by the exact id it recorded (CLAUDE.md iron
// rule 12): debtors (their history cascades), the temporary statuses and users.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string; full_name: string | null; role: string } },
  sendBulk: vi.fn(),
  legalEmail: '',
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
vi.mock('@/services/email', () => ({ sendBulkStatusChangeNotification: h.sendBulk }));
vi.mock('@/lib/db/appSettings', () => ({
  getLegalContact: vi.fn(async () => ({ name: 'עו"ד בדיקה', email: h.legalEmail })),
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { PUT: bulkPut } = await import('@/app/api/debtors/legal-status/bulk/route');

const uniq = `lsbulk-${Date.now()}`;
// Numeric apartments far from the e2e seed (the registry keys on digits only).
const APT = { a: '990101', b: '990102', c: '990103', d: '990104' };

interface UserRow { id: string; username: string; email: string; full_name: string | null; role: string }
let admin: UserRow;
let superAdmin: UserRow;
let manager: UserRow;
let viewer: UserRow;
const made = { users: [] as string[], debtors: [] as string[], statuses: [] as string[] };
const debtor: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' };
let tmpTarget = '';   // active, with a notification address
let tmpInactive = ''; // inactive
let warning = '';     // seeded "מכתב התראה"
let legalCare = '';   // seeded "לטיפול משפטי"
const TARGET_EMAIL = 'bulk-target@example.test';

async function makeUser(role: string, suffix: string): Promise<UserRow> {
  const r = await pool.query<UserRow>(
    `insert into public.users (username, email, password_hash, full_name, role, is_active)
     values ($1, $2, 'not-a-hash', $3, $4, true) returning id, username, email, full_name, role`,
    [`${uniq}-${suffix}`, `${uniq}-${suffix}@billing.local`, `משתמש ${suffix} ${uniq}`, role],
  );
  made.users.push(r.rows[0]!.id);
  return r.rows[0]!;
}

async function makeStatus(name: string, active: boolean, emails: string[] | null): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.statuses (name, color, is_active, sort_order, notification_emails)
     values ($1, '#112233', $2, 999, $3) returning id`,
    [name, active, emails],
  );
  made.statuses.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}

async function statusId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from public.statuses where name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`seeded status "${name}" missing`);
  return r.rows[0].id;
}

/** Back to a known state: no status, no audit trail, between tests. */
async function reset(statusByKey: Partial<Record<'a' | 'b' | 'c' | 'd', string | null>> = {}) {
  await pool.query(`delete from public.legal_status_history where debtor_id = any($1::uuid[])`, [Object.values(debtor)]);
  for (const k of ['a', 'b', 'c', 'd'] as const) {
    await pool.query(
      `update public.debtors set legal_status_id = $2, legal_status_source = 'MANUAL',
              legal_status_updated_at = null, legal_status_updated_by = null, legal_status_updated_by_name = null
        where id = $1`,
      [debtor[k], statusByKey[k] ?? null],
    );
  }
  h.sendBulk.mockReset();
  h.sendBulk.mockResolvedValue({ sent: 1, failed: 0 });
  h.legalEmail = '';
}

const as = (u: UserRow | null) => {
  h.session = u ? { sid: 's', user: { id: u.id, username: u.username, email: u.email, full_name: u.full_name, role: u.role } } : null;
};
const put = (body: unknown) =>
  bulkPut(new NextRequest('http://localhost/api/debtors/legal-status/bulk', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

const rowOf = async (key: 'a' | 'b' | 'c' | 'd') =>
  (await pool.query<{
    legal_status_id: string | null; legal_status_source: string | null; legal_status_updated_at: Date | null;
    legal_status_updated_by: string | null; legal_status_updated_by_name: string | null;
  }>(`select legal_status_id, legal_status_source, legal_status_updated_at, legal_status_updated_by, legal_status_updated_by_name
        from public.debtors where id = $1`, [debtor[key]])).rows[0]!;
const historyOf = async (key: 'a' | 'b' | 'c' | 'd') =>
  (await pool.query<{
    apartment_number: string; old_status_id: string | null; old_status_name: string | null;
    new_status_id: string | null; new_status_name: string | null; changed_by: string | null;
    changed_by_name: string | null; source: string;
  }>(`select apartment_number, old_status_id, old_status_name, new_status_id, new_status_name, changed_by, changed_by_name, source
        from public.legal_status_history where debtor_id = $1 order by changed_at, id`, [debtor[key]])).rows;
const ids = (...keys: Array<'a' | 'b' | 'c' | 'd'>) => keys.map((k) => debtor[k]);

d('bulk legal status on a real database', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const superId = await requireSeededAdmin(pool);
    superAdmin = (await pool.query<UserRow>(`select id, username, email, full_name, role from public.users where id = $1`, [superId])).rows[0]!;
    admin = await makeUser('admin', 'admin');
    manager = await makeUser('manager', 'manager');
    viewer = await makeUser('viewer', 'viewer');
    // The manager holds status_management:edit by default — the point is that it does not open the batch.
    for (const p of DEFAULT_MANAGER) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, $3, $4)`, [manager.id, p.module, p.canView, p.canEdit]);
    }
    for (const p of DEFAULT_VIEWER) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, $3, $4)`, [viewer.id, p.module, p.canView, p.canEdit]);
    }
    for (const [k, apt] of Object.entries(APT)) {
      const r = await pool.query<{ id: string }>(
        `insert into public.debtors (apartment_number, owner_name, total_debt, management_fees, hot_water_debt, special_debt, is_archived)
         values ($1, $2, 0, 0, 0, 0, false) returning id`,
        [apt, `בעלים ${k} ${uniq}`],
      );
      debtor[k as 'a'] = r.rows[0]!.id;
      made.debtors.push(r.rows[0]!.id);
    }
    warning = await statusId('מכתב התראה');
    legalCare = await statusId('לטיפול משפטי');
    tmpTarget = await makeStatus(`יעד בדיקה ${uniq}`, true, [TARGET_EMAIL]);
    tmpInactive = await makeStatus(`לא פעיל ${uniq}`, false, null);
  });

  afterAll(async () => {
    await pool.query(`drop trigger if exists lsbulk_fail_trg on public.debtors`);
    await pool.query(`drop function if exists public.lsbulk_fail()`);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]); // history cascades
    for (const id of made.statuses) await pool.query(`delete from public.statuses where id = $1`, [id]);
    for (const id of made.users) await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
    for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
    await pool.end();
  });

  beforeEach(async () => {
    as(admin);
    await reset();
  });

  it('writes what the single route writes, one history row per apartment, and sends ONE mail', async () => {
    await reset({ b: warning, c: tmpTarget }); // a: none · b: "מכתב התראה" · c: already on the target
    const res = await put({ debtor_ids: ids('c', 'b', 'a'), status_id: tmpTarget });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ updated: 2, skipped: 1, new: { id: tmpTarget }, email: { sent: 1, failed: 0 } });

    for (const k of ['a', 'b'] as const) {
      const r = await rowOf(k);
      expect(r.legal_status_id).toBe(tmpTarget);
      expect(r.legal_status_source).toBe('MANUAL');
      expect(r.legal_status_updated_at).toBeInstanceOf(Date);
      expect(r.legal_status_updated_by).toBe(admin.id);
      expect(r.legal_status_updated_by_name).toBe(admin.full_name);
    }
    expect(await historyOf('a')).toEqual([{
      apartment_number: APT.a, old_status_id: null, old_status_name: null,
      new_status_id: tmpTarget, new_status_name: `יעד בדיקה ${uniq}`,
      changed_by: admin.id, changed_by_name: admin.full_name, source: 'MANUAL',
    }]);
    expect(await historyOf('b')).toEqual([expect.objectContaining({
      old_status_id: warning, old_status_name: 'מכתב התראה', new_status_id: tmpTarget, source: 'MANUAL',
    })]);
    // the apartment already on the target: untouched, no history
    expect((await rowOf('c')).legal_status_updated_at).toBeNull();
    expect(await historyOf('c')).toHaveLength(0);

    // ONE consolidated mail: both changed apartments, in apartment order, to the status's address
    expect(h.sendBulk).toHaveBeenCalledTimes(1);
    expect(h.sendBulk.mock.calls[0]![0]).toEqual({
      new_status_name: `יעד בדיקה ${uniq}`,
      changes: [
        { apartment_number: APT.a, owner_name: `בעלים a ${uniq}`, old_status_name: null },
        { apartment_number: APT.b, owner_name: `בעלים b ${uniq}`, old_status_name: 'מכתב התראה' },
      ],
      changed_by_name: admin.full_name,
      recipients: [TARGET_EMAIL],
    });
  });

  it('super admin may too', async () => {
    as(superAdmin);
    const res = await put({ debtor_ids: ids('a'), status_id: tmpTarget });
    expect(res.status).toBe(200);
    expect((await rowOf('a')).legal_status_updated_by).toBe(superAdmin.id);
  });

  it('every apartment already on the target: nothing written, no history, no mail', async () => {
    await reset({ a: tmpTarget, b: tmpTarget });
    const res = await put({ debtor_ids: ids('a', 'b'), status_id: tmpTarget });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 0, skipped: 2, email: null });
    expect(await historyOf('a')).toHaveLength(0);
    expect(h.sendBulk).not.toHaveBeenCalled();
  });

  it('a legal status adds the lawyer from Settings; a status without addresses sends nothing', async () => {
    h.legalEmail = 'lawyer@firm.test';
    await put({ debtor_ids: ids('a', 'b'), status_id: legalCare });
    expect(h.sendBulk).toHaveBeenCalledTimes(1);
    expect(h.sendBulk.mock.calls[0]![0].recipients).toEqual(['lawyer@firm.test']);

    await reset();
    const res = await put({ debtor_ids: ids('a'), status_id: warning }); // no addresses, not legal
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBeNull();
    expect(h.sendBulk).not.toHaveBeenCalled();
  });

  it('a mail that fails never undoes the change', async () => {
    h.sendBulk.mockRejectedValue(new Error('smtp down'));
    const res = await put({ debtor_ids: ids('a', 'b'), status_id: tmpTarget });
    expect(res.status).toBe(200);
    expect((await res.json()).email.failed).toBeGreaterThan(0);
    expect((await rowOf('a')).legal_status_id).toBe(tmpTarget);
    expect(await historyOf('b')).toHaveLength(1);
  });

  it('all or nothing: an unknown apartment → 404 naming it, no row and no history changed', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    const res = await put({ debtor_ids: [...ids('a', 'b'), ghost], status_id: tmpTarget });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'debtor_not_found', missing_ids: [ghost] });
    expect((await rowOf('a')).legal_status_id).toBeNull();
    expect(await historyOf('a')).toHaveLength(0);
    expect(h.sendBulk).not.toHaveBeenCalled();
  });

  it('an inactive or unknown status → 400, nothing changes', async () => {
    for (const status_id of [tmpInactive, '00000000-0000-4000-8000-0000000000ff']) {
      const res = await put({ debtor_ids: ids('a', 'b'), status_id });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_status_id');
    }
    expect((await rowOf('a')).legal_status_id).toBeNull();
    expect(await historyOf('a')).toHaveLength(0);
  });

  it('a write that fails halfway rolls EVERYTHING back (history of the earlier apartments too)', async () => {
    await pool.query(`
      create or replace function public.lsbulk_fail() returns trigger language plpgsql as
      $$ begin raise exception 'lsbulk: forced failure on %', new.apartment_number; end $$`);
    await pool.query(`
      create trigger lsbulk_fail_trg before update on public.debtors
      for each row when (new.apartment_number = '${APT.c}') execute function public.lsbulk_fail()`);
    try {
      await expect(put({ debtor_ids: ids('a', 'b', 'c'), status_id: tmpTarget })).rejects.toThrow(/forced failure/);
    } finally {
      await pool.query(`drop trigger if exists lsbulk_fail_trg on public.debtors`);
      await pool.query(`drop function if exists public.lsbulk_fail()`);
    }
    for (const k of ['a', 'b', 'c'] as const) {
      expect((await rowOf(k)).legal_status_id).toBeNull();
      expect(await historyOf(k)).toHaveLength(0);
    }
    expect(h.sendBulk).not.toHaveBeenCalled();
  });

  it('refuses a manager (even with status_management:edit), a viewer and no session — nothing changes', async () => {
    for (const who of [manager, viewer, null]) {
      as(who);
      const res = await put({ debtor_ids: ids('a', 'b'), status_id: tmpTarget });
      expect(res.status, who?.role ?? 'no session').toBe(who ? 403 : 401);
    }
    expect((await rowOf('a')).legal_status_id).toBeNull();
    expect(await historyOf('a')).toHaveLength(0);
    expect(h.sendBulk).not.toHaveBeenCalled();
  });

  it('validates the body: empty list, a non-uuid id, a null status (bulk never clears)', async () => {
    for (const body of [
      { debtor_ids: [], status_id: tmpTarget },
      { debtor_ids: ['nope'], status_id: tmpTarget },
      { debtor_ids: ids('a'), status_id: null },
      { debtor_ids: ids('a') },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    expect((await rowOf('a')).legal_status_id).toBeNull();
  });
});

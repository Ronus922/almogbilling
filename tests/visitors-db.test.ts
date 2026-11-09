import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { requireSeededAdmin } from './db-fixtures';

// The visitor-scan routes against a REAL database ("סריקת כניסה", 08/11/2026):
// who may read, scan, change and delete — role by role — and how the table is
// searched and paged. Storage and the OCR are stand-ins (nothing leaves the
// process); the database, the SQL, the audit rows and the role guards are real.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// Every row it creates is removed by the exact id it recorded (CLAUDE.md iron
// rule 12): the temporary users, their scans, and the audit rows of those scans.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

const h = vi.hoisted(() => ({
  session: null as null | { sid: string; user: { id: string; username: string; email: string | null; full_name: string | null; role: string } },
  uploaded: [] as string[],
  removed: [] as string[],
  failInsert: false,
}));

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => {
    if (h.failInsert && text.includes('insert into public.visitor_scans')) return Promise.reject(new Error('insert failed'));
    return pool.query(text, params);
  },
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
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/storage/server', () => ({
  VISITOR_IDS_BUCKET: 'visitor-ids',
  buildProxyUrl: (bucket: string, key: string) => `/api/files/${bucket}/${key}`,
}));
vi.mock('@/lib/storage/visitorIdStorage', () => ({
  uploadVisitorPhoto: vi.fn(async () => {
    const key = `${randomUUID()}.jpg`;
    h.uploaded.push(key);
    return key;
  }),
  removeVisitorPhoto: vi.fn(async (key: string) => { h.removed.push(key); }),
}));

import { GET, POST } from '@/app/api/visitors/route';
import { DELETE, PATCH } from '@/app/api/visitors/[id]/route';
import { deleteUserPermanently } from '@/lib/db/userDeletion';
import { insertVisitorScan } from '@/lib/db/visitorScans';
import { requireVisitorView } from '@/lib/auth/actor';
import { AuthorizationError } from '@/lib/auth/errors';
import { ROLE_VALUES, isMatrixRole, type Role } from '@/lib/permissions/constants';
import { getDefaultPermissions } from '@/lib/permissions/check';

const RUN = Date.now().toString(36);
const userIds = new Map<Role, string>();
const scanIds: string[] = [];
let extraUserIds: string[] = [];

const FIELDS = {
  document_type: 'id_card', document_number: '123456789', first_name: 'דוד', last_name: `VT${RUN}`,
  date_of_birth: '1990-05-17', nationality: 'ישראלית', phone: '050-123 4567', room_number: '12', chip_number: 'C-77', notes: '',
};

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 100, channels: 3, background: '#336699' } }).jpeg().toBuffer();
}

async function actAs(role: Role | null) {
  h.session = role === null ? null : {
    sid: `sid-${role}`,
    user: { id: userIds.get(role)!, username: `vt-${RUN}-${role}`, email: role === 'guard' ? null : `vt-${RUN}-${role}@example.test`, full_name: `בודק ${role}`, role },
  };
}

function formReq(fields: Record<string, unknown>, image: Buffer | null): NextRequest {
  const fd = new FormData();
  if (image) fd.append('image', new File([new Uint8Array(image)], 'scan.jpg', { type: 'image/jpeg' }));
  fd.append('data', JSON.stringify(fields));
  return new NextRequest('http://localhost/api/visitors', { method: 'POST', body: fd });
}
const jsonReq = (method: string, body: unknown) =>
  new NextRequest('http://localhost/api/visitors/x', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const listReq = (qs: string) => new NextRequest(`http://localhost/api/visitors?${qs}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Insert a scan straight into the table (a test fixture, recorded for cleanup). */
async function seedScan(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const f = { ...FIELDS, ...over } as Record<string, string | null>;
  const r = await pool.query<{ id: string }>(
    `insert into public.visitor_scans (document_type, document_number, first_name, last_name, date_of_birth, phone,
       image_object_key, scanned_by, scanned_by_name, created_at)
     values ($1, $2, $3, $4, $5::date, $6, $7, $8, 'בודק', coalesce($9::timestamptz, now())) returning id`,
    [f.document_type, f.document_number, f.first_name, f.last_name, f.date_of_birth, f.phone,
      `${randomUUID()}.jpg`, userIds.get('admin'), (over.created_at as string | undefined) ?? null],
  );
  scanIds.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}

const count = async (id: string) =>
  (await pool.query<{ n: number }>(`select count(*)::int as n from public.visitor_scans where id = $1`, [id])).rows[0]!.n;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_URL, max: 4 });
  pool.on('error', () => undefined);
  await requireSeededAdmin(pool);
  for (const role of ROLE_VALUES) {
    const r = await pool.query<{ id: string }>(
      `insert into public.users (username, email, full_name, password_hash, role)
       values ($1, $2, $3, 'x', $4) returning id`,
      [`vt-${RUN}-${role}`, role === 'guard' ? null : `vt-${RUN}-${role}@example.test`, `בודק ${role}`, role],
    );
    userIds.set(role, r.rows[0]!.id);
    // A matrix role as the Users screen creates it: its default rows (a viewer with none is "zero
    // access" and is locked out — asserted below). Removed with the user (ON DELETE CASCADE).
    if (isMatrixRole(role)) {
      for (const p of getDefaultPermissions(role) ?? []) {
        await pool.query(
          `insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, $3, $4)`,
          [r.rows[0]!.id, p.module, p.canView, p.canEdit],
        );
      }
    }
  }
});

beforeEach(() => { h.uploaded.length = 0; h.removed.length = 0; h.failInsert = false; });

afterAll(async () => {
  if (!pool) return;
  const ids = [...scanIds];
  // POST-created scans were recorded by the tests that made them; sweep the rest by the author ids we own.
  const mine = [...userIds.values(), ...extraUserIds];
  const strays = await pool.query<{ id: string }>(`select id from public.visitor_scans where scanned_by = any($1::uuid[])`, [mine]);
  ids.push(...strays.rows.map((r) => r.id));
  await pool.query(`delete from public.audit_log where entity_type = 'visitor_scan' and entity_id = any($1::text[])`, [ids]);
  await pool.query(`delete from public.visitor_scans where id = any($1::uuid[])`, [ids]);
  await pool.query(`delete from public.users where id = any($1::uuid[])`, [mine]);
  await pool.end();
});

d('reading — guard, admin and super admin only; nobody anonymous', () => {
  it.each(['guard', 'admin', 'super_admin'] as Role[])('%s: GET /api/visitors → 200', async (role) => {
    await actAs(role);
    const res = await GET(listReq(`q=VT${RUN}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ page: 1, page_size: 25 });
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it.each(['manager', 'viewer', 'cleaner', 'maintenance'] as Role[])('%s: GET /api/visitors → 403, and the photo guard refuses too (09/11/2026)', async (role) => {
    await seedScan({ last_name: `VTcl${RUN}${role}` });
    await actAs(role);
    const res = await GET(listReq(`q=VTcl${RUN}`));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(`VTcl${RUN}`); // no row leaks into the refusal
    await expect(requireVisitorView()).rejects.toBeInstanceOf(AuthorizationError); // /api/files/visitor-ids
  });

  it.each(['guard', 'admin', 'super_admin'] as Role[])('%s: the photo guard lets them in', async (role) => {
    await actAs(role);
    await expect(requireVisitorView()).resolves.toMatchObject({ role });
  });

  it('no session → 401', async () => {
    await actAs(null);
    expect((await GET(listReq(''))).status).toBe(401);
  });

  it('a row goes out with a same-origin proxy path, never the object key or a storage URL', async () => {
    const id = await seedScan({ last_name: `VTproxy${RUN}` });
    await actAs('guard');
    const body = await (await GET(listReq(`q=VTproxy${RUN}`))).json();
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0];
    expect(row.id).toBe(id);
    expect(row.image_url).toMatch(/^\/api\/files\/visitor-ids\/[0-9a-f-]{36}\.jpg$/);
    expect(row).not.toHaveProperty('image_object_key');
    expect(JSON.stringify(row)).not.toMatch(/storage\/v1|bios\.co\.il|https?:/);
  });
});

d('a matrix grant cannot open the screen', () => {
  it('a manager and a viewer holding EVERY module at view+edit still get 403 — the role is the whole test', async () => {
    for (const role of ['manager', 'viewer'] as Role[]) {
      const uid = userIds.get(role)!;
      const before = await pool.query(`select module, can_view, can_edit from public.user_permissions where user_id = $1`, [uid]);
      await actAs(role);
      try {
        await pool.query(`update public.user_permissions set can_view = true, can_edit = true where user_id = $1`, [uid]);
        expect((await GET(listReq(`q=VT${RUN}`))).status).toBe(403);
      } finally {
        for (const row of before.rows) {
          await pool.query(`update public.user_permissions set can_view = $2, can_edit = $3 where user_id = $1 and module = $4`, [uid, row.can_view, row.can_edit, row.module]);
        }
      }
    }
  });
});

d('scanning — guard, admin, super admin only', () => {
  it.each(['guard', 'admin', 'super_admin'] as Role[])('%s: POST → 201, photo stored, row saved, audit without the document number', async (role) => {
    await actAs(role);
    const res = await POST(formReq({ ...FIELDS, last_name: `VTpost${RUN}${role}` }, await jpeg()));
    expect(res.status).toBe(201);
    const { id, scan } = await res.json();
    scanIds.push(id);
    expect(scan).toMatchObject({ first_name: 'דוד', document_type: 'id_card', date_of_birth: '1990-05-17', scanned_by: userIds.get(role) });
    expect(scan.scanned_by_name).toBe(`בודק ${role}`);
    expect(h.uploaded).toHaveLength(1);
    expect(scan.image_url).toBe(`/api/files/visitor-ids/${h.uploaded[0]}`);

    const audit = await pool.query(`select action, actor_user_id, metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1`, [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: 'created', actor_user_id: userIds.get(role) });
    expect(JSON.stringify(audit.rows[0])).not.toContain('123456789');
    expect(JSON.stringify(audit.rows[0])).not.toContain('VTpost');
  });

  it.each(['manager', 'viewer', 'cleaner', 'maintenance'] as Role[])('%s: POST → 403, nothing stored', async (role) => {
    await actAs(role);
    const before = (await pool.query(`select count(*)::int as n from public.visitor_scans`)).rows[0].n;
    const res = await POST(formReq({ ...FIELDS, last_name: `VTno${RUN}${role}` }, await jpeg()));
    expect(res.status).toBe(403);
    expect(h.uploaded).toHaveLength(0);
    expect((await pool.query(`select count(*)::int as n from public.visitor_scans`)).rows[0].n).toBe(before);
  });

  it('no session → 401', async () => {
    await actAs(null);
    expect((await POST(formReq(FIELDS, await jpeg()))).status).toBe(401);
  });

  it('the same person saved twice within minutes (a lost answer, a second tap) is ONE row and ONE photo', async () => {
    await actAs('guard');
    const f = { ...FIELDS, last_name: `VTdup${RUN}`, document_number: '55555' };
    const first = await POST(formReq(f, await jpeg()));
    expect(first.status).toBe(201);
    const { id } = await first.json();
    scanIds.push(id);
    const second = await POST(formReq(f, await jpeg()));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body).toMatchObject({ id, duplicate: true });
    expect(h.uploaded).toHaveLength(1); // the second never reached Storage
    expect((await pool.query(`select count(*)::int as n from public.visitor_scans where last_name = $1`, [`VTdup${RUN}`])).rows[0].n).toBe(1);
    // another document, or another guard, is a new scan
    await actAs('admin');
    const other = await POST(formReq(f, await jpeg()));
    expect(other.status).toBe(201);
    scanIds.push((await other.json()).id);
  });

  it('validation: a missing required field, a bad type, a missing photo, a non-image', async () => {
    await actAs('guard');
    expect((await POST(formReq({ ...FIELDS, first_name: '' }, await jpeg()))).status).toBe(400);
    expect((await POST(formReq({ ...FIELDS, document_type: 'visa' }, await jpeg()))).status).toBe(400);
    expect((await POST(formReq(FIELDS, null))).status).toBe(400);
    expect((await POST(formReq(FIELDS, Buffer.from('definitely not an image')))).status).toBe(422);
    expect(h.uploaded).toHaveLength(0);
  });

  it('if the row cannot be written the photo is removed again (no orphan)', async () => {
    await actAs('guard');
    h.failInsert = true;
    const res = await POST(formReq({ ...FIELDS, last_name: `VTfail${RUN}` }, await jpeg()));
    expect(res.status).toBe(500);
    expect(h.uploaded).toHaveLength(1);
    expect(h.removed).toEqual(h.uploaded);
  });
});

d('a runaway client', () => {
  it('120 saves an hour per user, then 429 — and nothing is stored for the refused one', async () => {
    const bucket = `visitor-save:user:${userIds.get('guard')}`;
    const past = await pool.query<{ id: string }>(
      `insert into public.auth_rate_limits (bucket) select $1 from generate_series(1, 120) returning id`,
      [bucket],
    );
    try {
      await actAs('guard');
      const res = await POST(formReq({ ...FIELDS, last_name: `VTrate${RUN}` }, await jpeg()));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).not.toBeNull();
      expect(h.uploaded).toHaveLength(0);
    } finally {
      await pool.query(`delete from public.auth_rate_limits where id = any($1::bigint[])`, [past.rows.map((r) => r.id)]);
    }
  });
});

d('changing a saved scan', () => {
  it('guard: the notes — yes', async () => {
    const id = await seedScan({ last_name: `VTnote${RUN}` });
    await actAs('guard');
    const res = await PATCH(jsonReq('PATCH', { notes: ' אושר על ידי הדייר ' }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).scan.notes).toBe('אושר על ידי הדייר');
    const audit = await pool.query(`select metadata from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1 and action = 'updated'`, [id]);
    expect(audit.rows[0].metadata).toMatchObject({ fields: ['notes'], actor_role: 'guard' });
  });

  it.each([
    ['first_name', { first_name: 'שונה' }],
    ['document_number', { document_number: '999' }],
    ['notes + another field', { notes: 'x', phone: '050' }],
    ['a column that is not editable', { image_object_key: 'x.jpg' }],
  ])('guard: %s → 403 and the row is untouched (locked on the SERVER)', async (_n, body) => {
    const id = await seedScan({ last_name: `VTlock${RUN}` });
    await actAs('guard');
    const before = (await pool.query(`select * from public.visitor_scans where id = $1`, [id])).rows[0];
    const res = await PATCH(jsonReq('PATCH', body), ctx(id));
    expect(res.status).toBe(403);
    const after = (await pool.query(`select * from public.visitor_scans where id = $1`, [id])).rows[0];
    expect(after).toEqual(before);
  });

  it.each(['admin', 'super_admin'] as Role[])('%s: every field; blanks clear the column', async (role) => {
    const id = await seedScan({ last_name: `VTedit${RUN}${role}` });
    await actAs(role);
    const res = await PATCH(jsonReq('PATCH', { first_name: 'דני', phone: '', date_of_birth: '1985-01-02', document_type: 'passport' }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).scan).toMatchObject({ first_name: 'דני', phone: null, date_of_birth: '1985-01-02', document_type: 'passport' });
  });

  it('admin: a bad value → 400; an unknown key → 400; an empty body → 400; a bad id → 404', async () => {
    const id = await seedScan({ last_name: `VTbad${RUN}` });
    await actAs('admin');
    expect((await PATCH(jsonReq('PATCH', { date_of_birth: '1990-02-31' }), ctx(id))).status).toBe(400);
    expect((await PATCH(jsonReq('PATCH', { scanned_by: userIds.get('guard') }), ctx(id))).status).toBe(400);
    expect((await PATCH(jsonReq('PATCH', {}), ctx(id))).status).toBe(400);
    expect((await PATCH(jsonReq('PATCH', { notes: 'x' }), ctx('not-a-uuid'))).status).toBe(404);
    expect((await PATCH(jsonReq('PATCH', { notes: 'x' }), ctx(randomUUID()))).status).toBe(404);
  });

  it.each(['manager', 'viewer', 'cleaner', 'maintenance'] as Role[])('%s: PATCH → 403 even for the notes', async (role) => {
    const id = await seedScan({ last_name: `VTro${RUN}${role}` });
    await actAs(role);
    expect((await PATCH(jsonReq('PATCH', { notes: 'x' }), ctx(id))).status).toBe(403);
    expect((await pool.query(`select notes from public.visitor_scans where id = $1`, [id])).rows[0].notes).toBeNull();
  });
});

d('deleting', () => {
  it('admin / super admin: the row goes, then the photo (by the stored key)', async () => {
    for (const role of ['admin', 'super_admin'] as Role[]) {
      const id = await seedScan({ last_name: `VTdel${RUN}${role}` });
      const key = (await pool.query<{ image_object_key: string }>(`select image_object_key from public.visitor_scans where id = $1`, [id])).rows[0]!.image_object_key;
      await actAs(role);
      const res = await DELETE(new NextRequest('http://localhost/api/visitors/x', { method: 'DELETE' }), ctx(id));
      expect(res.status).toBe(200);
      expect(await count(id)).toBe(0);
      expect(h.removed).toContain(key);
      const audit = await pool.query(`select action from public.audit_log where entity_type = 'visitor_scan' and entity_id = $1 and action = 'deleted'`, [id]);
      expect(audit.rows).toHaveLength(1);
    }
  });

  it.each(['guard', 'manager', 'viewer', 'cleaner', 'maintenance'] as Role[])('%s: DELETE → 403, row and photo stay', async (role) => {
    const id = await seedScan({ last_name: `VTnodel${RUN}${role}` });
    await actAs(role);
    expect((await DELETE(new NextRequest('http://localhost/api/visitors/x', { method: 'DELETE' }), ctx(id))).status).toBe(403);
    expect(await count(id)).toBe(1);
    expect(h.removed).toHaveLength(0);
  });

  it('an unknown id → 404 and no photo is touched', async () => {
    await actAs('admin');
    expect((await DELETE(new NextRequest('http://localhost/api/visitors/x', { method: 'DELETE' }), ctx(randomUUID()))).status).toBe(404);
    expect(h.removed).toHaveLength(0);
  });
});

d('searching and paging', () => {
  const TOKEN = `VTs${RUN}`;

  it('a name, either order, any case; a phone however it is written', async () => {
    await seedScan({ first_name: 'דוד', last_name: TOKEN, phone: '050-123 4567' });
    await seedScan({ first_name: 'משה', last_name: TOKEN, phone: null });
    await actAs('guard');
    const find = async (q: string) => (await (await GET(listReq(`q=${encodeURIComponent(q)}`))).json()).rows as { first_name: string }[];

    expect((await find(TOKEN)).length).toBe(2);
    expect((await find(TOKEN.toUpperCase())).map((r) => r.first_name)).toEqual(expect.arrayContaining(['דוד', 'משה']));
    expect((await find(`דוד ${TOKEN}`)).map((r) => r.first_name)).toEqual(['דוד']);
    expect((await find(`${TOKEN} דוד`)).map((r) => r.first_name)).toEqual(['דוד']);
    expect((await find('0501234567')).some((r) => r.first_name === 'דוד')).toBe(true);
    expect((await find('050 123')).some((r) => r.first_name === 'דוד')).toBe(true);
    expect((await find('123-45')).some((r) => r.first_name === 'דוד')).toBe(true);
    // the number was written with the international prefix: a local-format search still finds it, and back
    await seedScan({ first_name: 'שרה', last_name: TOKEN, phone: '+972 50 765 4321' });
    expect((await find('0507654321')).some((r) => r.first_name === 'שרה')).toBe(true);
    expect((await find('+972507654321')).some((r) => r.first_name === 'שרה')).toBe(true);
    expect((await find('050-765')).some((r) => r.first_name === 'שרה')).toBe(true);
    // fewer than 3 digits is not a phone search, and matches no name
    expect(await find('05')).toHaveLength(0);
  });

  it('LIKE wildcards in the text are matched literally', async () => {
    await seedScan({ first_name: '100%', last_name: TOKEN });
    await seedScan({ first_name: '100x', last_name: TOKEN }); // a "%" that worked as a wildcard would match this one too
    await actAs('guard');
    const find = async (q: string) => (await (await GET(listReq(`q=${encodeURIComponent(q)}`))).json()).rows as { first_name: string; last_name: string }[];
    const pct = await find('100%');
    expect(pct.map((r) => r.first_name)).toEqual(['100%']);
    const lone = await find('%');
    expect(lone.length).toBeGreaterThan(0); // not vacuous: the "%" row is there …
    expect(lone.every((r) => `${r.first_name}${r.last_name}`.includes('%'))).toBe(true); // … and nothing else
    expect((await find('1_0')).length).toBe(0); // "_" is not "any one character"
  });

  it('the day range is inclusive and counted in ISRAEL time, winter and summer', async () => {
    const token = `VTd${RUN}`;
    // Winter (UTC+2): 21:30Z = 23:30 on the 10th; 22:30Z = 00:30 on the 11th.
    const w1 = await seedScan({ last_name: token, created_at: '2026-03-10T21:30:00Z' });
    const w2 = await seedScan({ last_name: token, created_at: '2026-03-10T22:30:00Z' });
    // Summer (UTC+3): 20:30Z = 23:30 on the 10th; 21:30Z = 00:30 on the 11th.
    const s1 = await seedScan({ last_name: token, created_at: '2026-07-10T20:30:00Z' });
    const s2 = await seedScan({ last_name: token, created_at: '2026-07-10T21:30:00Z' });
    await actAs('guard');
    const ids = async (from: string, to: string) =>
      ((await (await GET(listReq(`q=${token}&from=${from}&to=${to}`))).json()).rows as { id: string }[]).map((r) => r.id).sort();

    expect(await ids('2026-03-10', '2026-03-10')).toEqual([w1]);
    expect(await ids('2026-03-11', '2026-03-11')).toEqual([w2]);
    expect(await ids('2026-03-10', '2026-03-11')).toEqual([w1, w2].sort());
    expect(await ids('2026-07-10', '2026-07-10')).toEqual([s1]);
    expect(await ids('2026-07-11', '2026-07-11')).toEqual([s2]);
    // open-ended: only a start, only an end
    const open = async (qs: string) => ((await (await GET(listReq(`q=${token}&${qs}`))).json()).rows as { id: string }[]).length;
    expect(await open('from=2026-07-11')).toBe(1);
    expect(await open('to=2026-03-10')).toBe(1);
    expect(await open('')).toBe(4);
  });

  it('newest first; 25 to a page; the total is the whole match', async () => {
    const token = `VTp${RUN}`;
    for (let i = 0; i < 27; i += 1) {
      await seedScan({ first_name: `n${String(i).padStart(2, '0')}`, last_name: token, created_at: `2026-01-01T10:${String(i).padStart(2, '0')}:00Z` });
    }
    await actAs('guard');
    const p1 = await (await GET(listReq(`q=${token}&page=1`))).json();
    const p2 = await (await GET(listReq(`q=${token}&page=2`))).json();
    expect(p1.total).toBe(27);
    expect(p1.rows).toHaveLength(25);
    expect(p2.rows).toHaveLength(2);
    expect(p1.rows[0].first_name).toBe('n26');
    expect(p2.rows[1].first_name).toBe('n00');
    expect((await GET(listReq('page=0'))).status).toBe(400);
    expect((await GET(listReq('from=1.1.2026'))).status).toBe(400);
    expect((await GET(listReq('from=2026-02-31'))).status).toBe(400); // a Postgres error would be a 500
    expect((await GET(listReq(`q=${encodeURIComponent('a\u0000b')}`))).status).toBe(400);
    // the list is personal data: never cached
    expect((await GET(listReq(`q=${token}`))).headers.get('cache-control')).toBe('private, no-store');
  });
});

d('a deleted user leaves their scans readable under their name', () => {
  it('scanned_by goes to NULL, scanned_by_name stays', async () => {
    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, full_name, password_hash, role) values ($1, null, 'שומר זמני', 'x', 'guard') returning id`,
      [`vt-${RUN}-temp`],
    );
    const uid = u.rows[0]!.id;
    extraUserIds = [...extraUserIds, uid];
    const id = await insertVisitorScan({
      document_type: 'id_card', document_number: '1', first_name: 'א', last_name: `VTgone${RUN}`,
      date_of_birth: null, nationality: null, phone: null, room_number: null, chip_number: null, notes: null,
      image_object_key: `${randomUUID()}.jpg`, image_original_name: null, scanned_by: uid,
    });
    scanIds.push(id);

    await deleteUserPermanently({ id: uid, username: `vt-${RUN}-temp`, full_name: 'שומר זמני' });

    const row = (await pool.query(`select scanned_by, scanned_by_name from public.visitor_scans where id = $1`, [id])).rows[0];
    expect(row).toEqual({ scanned_by: null, scanned_by_name: 'שומר זמני' });
    extraUserIds = extraUserIds.filter((x) => x !== uid);
  });
});

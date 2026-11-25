import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

// The sweep of lease files nobody saved (25/11/2026), against a throwaway
// database (WA_TEST_DATABASE_URL), never prod. Storage is handed in (a `remove`
// that records what it was asked to delete), so the RULE is what is tested:
//   · a lease the issue window uploaded, that no saved order line, holder line
//     or chip points at, is deleted once it is 24 hours old — the file first,
//     its row after;
//   · a lease that IS attached is never deleted, however old, wherever it is
//     attached (a chip, a line of a web order, a holder line);
//   · younger than 24 hours — kept;
//   · ONLY what this database recorded: Storage is never asked to delete a key
//     that has no upload row here, and a row is made by the window's upload
//     alone — the bucket is never listed;
//   · one run deletes no more than its ceiling; the rest waits for the next;
//   · Storage refusing a file keeps its row for the next run;
//   · a save that is attaching a file holds it: the purge skips it, and a file
//     the purge already deleted cannot be attached by a save any more;
//   · deleting an order with its lease files forgets their rows.
// Fixtures are numeric apartments far from the seed and random keys, removed
// by exact ids.

const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
}));
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined) }));

const { requireSeededAdmin } = await import('./db-fixtures');
const { purgeUnattachedLeases, UNATTACHED_LEASE_TTL_HOURS, LEASE_PURGE_MAX_PER_RUN } = await import('@/lib/chipOrders/cleanup');
const leases = await import('@/lib/db/chipLeaseUploads');
const { saveReceptionWindow, ReceptionError } = await import('@/lib/db/chipReception');
const { deleteChipOrderWithLeases } = await import('@/lib/db/chipOrders');
const { issueChipGroups } = await import('@/lib/db/chips');
const { EMPTY_RECEPTION_ORDERER } = await import('@/lib/chipOrders/reception');

const tag = String(Date.now()).slice(-6);
const APT = (n: number) => `999${tag}${n}`;
const num = (n: number) => `L${tag}${n}`;
const made = { contacts: {} as Record<string, string>, orders: [] as string[], keys: [] as string[] };
let admin: { id: string; name: string };

const key = (ext = 'pdf') => { const k = `${randomUUID()}.${ext}`; made.keys.push(k); return k; };
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await pool.query<T>(sql, params)).rows[0] as T;
const tracked = async (k: string) => Number((await one<{ n: string }>(`select count(*) as n from public.chip_lease_uploads where object_key = $1`, [k])).n) === 1;
/** A lease as the issue window uploads it, `hours` ago. */
async function upload(hours: number, ext = 'pdf') {
  const k = key(ext);
  await leases.recordLeaseUpload(k, admin.id);
  await pool.query(`update public.chip_lease_uploads set uploaded_at = now() - make_interval(hours => $2) where object_key = $1`, [k, hours]);
  return k;
}
const ref = (k: string) => ({ key: k, name: 'חוזה שכירות.pdf', mime: 'application/pdf', size: 2048 });

/** A stand-in Storage: what it was asked to remove, and whether it agrees.
 *  Only the suite's own keys count — another suite's rows are not this one's
 *  business. */
function bucket(ok = true) {
  const removed: string[] = [];
  return { removed, remove: async (keys: string[]) => { removed.push(...keys); return ok; } };
}
const mine = (keys: string[]) => keys.filter((k) => made.keys.includes(k));
/** Every key that has an upload row right now. */
const recorded = async () => new Set((await pool.query<{ object_key: string }>(`select object_key from public.chip_lease_uploads`)).rows.map((r) => r.object_key));

d('the sweep of lease files nobody saved, on the DB', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    for (let i = 1; i <= 3; i++) {
      made.contacts[APT(i)] = (await one<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, tenant_name, tenant_phone) values ($1, 'בעלים רשום', 'שוכר רשום', '0539322111') returning id`, [APT(i)])).id;
    }
  });

  afterAll(async () => {
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    const rows = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const c of rows) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    const all = (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const o of [...all.map((r) => r.id), ...made.orders]) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [o]);
      await pool.query(`delete from public.chip_orders where id = $1`, [o]);
    }
    for (const id of contactIds) await pool.query(`delete from public.chip_reception_records where contact_id = $1`, [id]);
    for (const id of contactIds) await pool.query(`delete from public.audit_log where metadata->>'contact_id' = $1`, [id]);
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const k of made.keys) await pool.query(`delete from public.chip_lease_uploads where object_key = $1`, [k]);
    await pool.end();
  });

  it('the rule is 24 hours, and one run has a ceiling', () => {
    expect(UNATTACHED_LEASE_TTL_HOURS).toBe(24);
    expect(LEASE_PURGE_MAX_PER_RUN).toBeGreaterThan(0);
    expect(LEASE_PURGE_MAX_PER_RUN).toBeLessThanOrEqual(100);
  });

  it('a lease that was uploaded and never saved is deleted once it is 24 hours old — a younger one is kept', async () => {
    const stale = await upload(25);
    const fresh = await upload(23);
    const justNow = await upload(0);
    const b = bucket();
    const r = await purgeUnattachedLeases(b.remove);
    expect(mine(b.removed)).toEqual([stale]);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await tracked(stale)).toBe(false);
    expect(await tracked(fresh)).toBe(true);
    expect(await tracked(justNow)).toBe(true);
    // A second run has nothing left of it to delete.
    const again = bucket();
    await purgeUnattachedLeases(again.remove);
    expect(mine(again.removed)).toEqual([]);
  });

  it('a lease that is ATTACHED is never deleted, however old — on a chip, on a line of a web order, on a holder line', async () => {
    // On a chip: saved through the issue window.
    const onChip = await upload(1);
    await saveReceptionWindow(
      { contact_id: made.contacts[APT(1)]!, groups: [{ resident_role: 'tenant', chip_type: 'physical', numbers: [num(1)], lease: ref(onChip), lease_end_date: '2027-06-30' }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } }, 50, admin,
    );
    // On a web order: its apartment line (an order of the old kind) and a holder line.
    const onLine = key();
    const onHolder = key();
    const o = await one<{ id: string }>(
      `insert into public.chip_orders (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at, grow_process_id, grow_transaction_id)
       values ('שוכר מהאתר', '+972539300077', 'lease@example.test', 'כתובת 1', 'tenant', 'paid', 50, $1, now(), now() + interval '3 days', $2, $3) returning id`,
      [randomBytes(32).toString('base64url'), `lp-p-${tag}`, `lp-t-${tag}`]);
    made.orders.push(o.id);
    const item = await one<{ id: string }>(
      `insert into public.chip_order_items (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status, lease_file_key, lease_file_name)
       values ($1, $2, $3, 1, 50, 1, 50, 50, 'document_review', $4, 'חוזה ישן.pdf') returning id`, [o.id, made.contacts[APT(2)], APT(2), onLine]);
    await pool.query(
      `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, chips_count, lease_file_key, lease_file_name)
       values ($1, $2, 0, 'order', 'tenant', 'שוכר מהאתר', '+972539300077', 1, $3, 'חוזה.pdf')`, [o.id, item.id, onHolder]);

    // All three have an upload row that is a month old (the two of the web
    // order as if the window had uploaded them) — and all three are attached.
    for (const k of [onLine, onHolder]) await leases.recordLeaseUpload(k, admin.id);
    await pool.query(`update public.chip_lease_uploads set uploaded_at = now() - interval '30 days' where object_key = any($1::text[])`, [[onChip, onLine, onHolder]]);
    const b = bucket();
    await purgeUnattachedLeases(b.remove);
    expect(mine(b.removed)).toEqual([]);
    for (const k of [onChip, onLine, onHolder]) expect(await tracked(k)).toBe(true);
    // The candidates of the purge never even include an attached file.
    const candidates = await leases.listStaleUnattachedLeases(24, 10_000);
    for (const k of [onChip, onLine, onHolder]) expect(candidates).not.toContain(k);
  });

  it('a lease that was attached and then taken off the chip is deleted on the next run — it is 24 hours old and nothing points at it', async () => {
    const k = await upload(48);
    const res = await saveReceptionWindow(
      { contact_id: made.contacts[APT(1)]!, groups: [{ resident_role: 'other', holder_name: 'אורח עם חוזה', chip_type: 'physical', numbers: [num(2)], lease: ref(k) }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } }, 50, admin,
    );
    let b = bucket();
    await purgeUnattachedLeases(b.remove);
    expect(mine(b.removed)).toEqual([]);
    // "הסר" in the window, then "שמור שינויים".
    await saveReceptionWindow(
      { contact_id: made.contacts[APT(1)]!, groups: [], updates: [{ id: res.items[0]!.id, lease: null }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null }, 50, admin,
    );
    b = bucket();
    await purgeUnattachedLeases(b.remove);
    expect(mine(b.removed)).toEqual([k]);
    expect(await tracked(k)).toBe(false);
  });

  it('ONLY what this database recorded: Storage is never asked for a key that has no upload row here, and a row is made by the upload alone', async () => {
    // A lease of the public order page, an old upload from before the registry,
    // a file another database's instance put in the same bucket: none has a
    // row here — so nothing of them can be named to Storage, whatever their age.
    const stale = await upload(72);
    const before = await recorded();
    const b = bucket();
    const r = await purgeUnattachedLeases(b.remove);
    expect(b.removed).toContain(stale);
    // Every key Storage was asked to delete had a row before the run.
    for (const k of b.removed) expect(before.has(k)).toBe(true);
    // The run makes no rows: what it knows afterwards is what it knew, minus what it deleted.
    const after = await recorded();
    for (const k of after) expect(before.has(k)).toBe(true);
    expect(r.scanned).toBeGreaterThanOrEqual(r.deleted);
    // …and the registry holds lease keys only — the table itself refuses anything else.
    await expect(leases.recordLeaseUpload(`not-a-lease-${tag}.txt`, admin.id)).rejects.toThrow(/chip_lease_uploads/);
    await expect(leases.recordLeaseUpload(`../${randomUUID()}.pdf`, admin.id)).rejects.toThrow(/chip_lease_uploads/);
  });

  it('one run deletes no more than its ceiling — the rest waits for the next run', async () => {
    // Older than anything else in the table, so these are the run's candidates.
    const lot: string[] = [];
    for (let i = 0; i < LEASE_PURGE_MAX_PER_RUN + 3; i++) lot.push(await upload(24 * 400 + i));
    const first = bucket();
    const r = await purgeUnattachedLeases(first.remove);
    expect(r.scanned).toBe(LEASE_PURGE_MAX_PER_RUN);
    expect(first.removed).toHaveLength(LEASE_PURGE_MAX_PER_RUN);
    expect(mine(first.removed)).toHaveLength(LEASE_PURGE_MAX_PER_RUN);
    const second = bucket();
    await purgeUnattachedLeases(second.remove);
    expect(mine([...first.removed, ...second.removed]).sort()).toEqual([...lot].sort());
    for (const k of lot) expect(await tracked(k)).toBe(false);
  });

  it('Storage that refuses a file keeps its row — the next run tries again', async () => {
    const stale = await upload(30);
    const refused = bucket(false);
    const r = await purgeUnattachedLeases(refused.remove);
    expect(mine(refused.removed)).toEqual([stale]);
    expect(r.fileFailed).toBeGreaterThanOrEqual(1);
    expect(await tracked(stale)).toBe(true);
    const ok = bucket();
    await purgeUnattachedLeases(ok.remove);
    expect(mine(ok.removed)).toEqual([stale]);
    expect(await tracked(stale)).toBe(false);
  });

  it('a save that is attaching a file holds it: the purge skips the file and never asks Storage to delete it', async () => {
    const k = await upload(40);
    const saving = await pool.connect();
    try {
      await saving.query('BEGIN');
      // What a save does first (lockLeasesForAttach): the row, FOR SHARE.
      expect(await leases.lockLeasesForAttach(saving, [k])).toEqual([]);
      const removed: string[] = [];
      const outcome = await leases.purgeLeaseIfUnattached(k, 24, async (keys) => { removed.push(...keys); return true; });
      expect(outcome).toBe('skipped');
      expect(removed).toEqual([]);
      // The save writes its reference and commits.
      const chip = (await issueChipGroups(
        { contact_id: made.contacts[APT(3)]!, groups: [{ resident_role: 'other', holder_name: 'שמירה במקביל', chip_type: 'physical', numbers: [num(3)] }] }, admin)).items[0]!;
      await saving.query(`update public.chips set lease_file_key = $2, lease_file_name = 'חוזה.pdf' where id = $1`, [chip.id, k]);
      await saving.query('COMMIT');
    } finally {
      saving.release();
    }
    // Now it is attached: never deleted.
    const removed: string[] = [];
    expect(await leases.purgeLeaseIfUnattached(k, 24, async (keys) => { removed.push(...keys); return true; })).toBe('attached');
    expect(removed).toEqual([]);
    expect(await tracked(k)).toBe(true);
  });

  it('a file the purge already deleted cannot be attached by a save: the save is refused and stores nothing', async () => {
    const k = await upload(26);
    const b = bucket();
    await purgeUnattachedLeases(b.remove);
    expect(mine(b.removed)).toEqual([k]);
    // The window was left open for more than a day, and is saved now.
    const before = Number((await one<{ n: string }>(`select count(*) as n from public.chips where contact_id = $1`, [made.contacts[APT(3)]])).n);
    const err = await saveReceptionWindow(
      { contact_id: made.contacts[APT(3)]!, groups: [{ resident_role: 'tenant', chip_type: 'physical', numbers: [num(4)], lease: ref(k) }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } }, 50, admin,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ReceptionError);
    expect(err).toMatchObject({ code: 'lease_missing' });
    expect(Number((await one<{ n: string }>(`select count(*) as n from public.chips where contact_id = $1`, [made.contacts[APT(3)]])).n)).toBe(before);
    // …and so is a key that was never uploaded through the window at all.
    await expect(saveReceptionWindow(
      { contact_id: made.contacts[APT(3)]!, groups: [{ resident_role: 'tenant', chip_type: 'physical', numbers: [num(5)], lease: ref(key()) }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } }, 50, admin,
    )).rejects.toMatchObject({ code: 'lease_missing' });
  });

  it('a lease that a chip already carried before the registry existed passes — it is not the purge\'s to delete', async () => {
    const legacy = key();
    const chip = (await issueChipGroups(
      { contact_id: made.contacts[APT(3)]!, groups: [{ resident_role: 'other', holder_name: 'חוזה ותיק', chip_type: 'physical', numbers: [num(6)] }] }, admin)).items[0]!;
    await pool.query(`update public.chips set lease_file_key = $2, lease_file_name = 'חוזה ותיק.pdf' where id = $1`, [chip.id, legacy]);
    expect(await tracked(legacy)).toBe(false);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await leases.lockLeasesForAttach(c, [legacy])).toEqual([]);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    // A second chip of the same person may carry the same lease.
    const res = await saveReceptionWindow(
      { contact_id: made.contacts[APT(3)]!, groups: [{ resident_role: 'other', holder_name: 'חוזה ותיק', chip_type: 'physical', numbers: [num(7)], lease: ref(legacy) }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } }, 50, admin,
    );
    expect(res.items[0]!.lease_file_key).toBe(legacy);
  });

  it('deleting an order together with its lease files forgets their rows', async () => {
    const k = key();
    const o = await one<{ id: string }>(
      `insert into public.chip_orders (full_name, phone_e164, email, address, role, status, total, tracking_token)
       values ('לא שילם', '+972539300078', 'unpaid@example.test', 'כתובת 2', 'tenant', 'pending_payment', 50, $1) returning id`,
      [randomBytes(32).toString('base64url')]);
    made.orders.push(o.id);
    await pool.query(
      `insert into public.chip_order_items (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status, lease_file_key, lease_file_name)
       values ($1, $2, $3, 1, 50, 1, 50, 50, 'document_review', $4, 'חוזה.pdf')`, [o.id, made.contacts[APT(2)], APT(2), k]);
    await leases.recordLeaseUpload(k, admin.id);
    expect(await tracked(k)).toBe(true);
    const removed: string[] = [];
    expect(await deleteChipOrderWithLeases(o.id, 'unpaid', async (keys) => { removed.push(...keys); return true; })).toBe('deleted');
    expect(removed).toEqual([k]);
    expect(await tracked(k)).toBe(false);
  });
});

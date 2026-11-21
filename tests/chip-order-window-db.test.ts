import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The redesigned order page + issue window (20/11/2026) on the DB, against a
// throwaway database (WA_TEST_DATABASE_URL), never prod: rows = people stored
// as holder lines under the apartment line (price per apartment over all its
// rows), the window's blocks, ONE save that issues chips linked to the order
// line AND the holder line, holder edits reaching the linked chips, staff
// holders (never priced), the legacy block of an old order, the same person's
// earlier chips matched by phone, the note, and the test-order chip list.
// Fixtures are numeric apartments far from the seed, removed by exact ids.

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

const orders = await import('@/lib/db/chipOrders');
const win = await import('@/lib/db/chipOrderWindow');
const { issueChipGroups } = await import('@/lib/db/chips');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const apt = { a: `992${tag}1`, b: `992${tag}2`, c: `992${tag}3` };
const made = { contacts: [] as string[], orders: [] as string[] };
const ids: Record<string, string> = {};
let admin: { id: string; name: string };
const num = (n: number) => `W${tag}${n}`;

d('chip order window on the DB', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    for (const [k, n] of Object.entries(apt)) {
      const r = await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים רשום', '0539311111') returning id`, [n]);
      made.contacts.push(r.rows[0]!.id);
      ids[k] = r.rows[0]!.id;
    }
  });

  afterAll(async () => {
    if (!pool) return;
    const chips = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [made.contacts])).rows;
    for (const c of chips) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  const itemOf = async (orderId: string, aptNo: string) =>
    (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1 and apartment_number = $2`, [orderId, aptNo])).rows[0]!.id;

  it('rows of one apartment become ONE priced line and one holder line each', async () => {
    const o = await orders.createChipOrder(
      {
        fullName: 'דנה כהן', phoneE164: '+972539300001', email: 'dana@example.test', address: 'הרצל 1, חיפה 3300000', role: 'owner',
        ip: null, isTest: true, phoneVerified: false, renterTermsAccepted: true,
        addressParts: { street: 'הרצל 1', city: 'חיפה', zip: '3300000' },
        rows: [
          { role: 'owner', fullName: 'דנה כהן', apartmentNumber: apt.a, chipsCount: 2, phoneE164: '+972539300001', email: 'dana@example.test', lease: null, leaseEndDate: null },
          { role: 'tenant', fullName: 'שרה לוי', apartmentNumber: apt.a, chipsCount: 2, phoneE164: '+972539300002', email: null, lease: null, leaseEndDate: '2030-01-01' },
          { role: 'owner', fullName: 'דנה כהן', apartmentNumber: apt.b, chipsCount: 1, phoneE164: '+972539300001', email: null, lease: null, leaseEndDate: null },
        ],
      },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    ids.order = o.id;
    ids.token = (await pool.query<{ t: string }>(`select tracking_token as t from public.chip_orders where id = $1`, [o.id])).rows[0]!.t;
    // One flat price (21/11/2026): apartment A 4 chips + apartment B 1 = 5 × the price.
    const s = DEFAULT_CHIP_ORDER_SETTINGS;
    expect(o.total).toBe(5 * s.unitPrice);
    const items = (await pool.query(`select apartment_number, chips_count, line_total::float8 as lt, unit_price::float8 as up, price_above::float8 as pa from public.chip_order_items where order_id = $1 order by apartment_number`, [o.id])).rows;
    expect(items.map((i) => [i.apartment_number, i.chips_count])).toEqual([[apt.a, 4], [apt.b, 1]]);
    expect(items.map((i) => [i.lt, i.up, i.pa])).toEqual([[4 * s.unitPrice, s.unitPrice, s.unitPrice], [s.unitPrice, s.unitPrice, s.unitPrice]]);
    const holders = (await pool.query(`select role, full_name, phone, chips_count, source, lease_end_date is not null as has_end from public.chip_order_holders where order_id = $1 order by position`, [o.id])).rows;
    expect(holders).toEqual([
      { role: 'owner', full_name: 'דנה כהן', phone: '+972539300001', chips_count: 2, source: 'order', has_end: false },
      { role: 'tenant', full_name: 'שרה לוי', phone: '+972539300002', chips_count: 2, source: 'order', has_end: true },
      { role: 'owner', full_name: 'דנה כהן', phone: '+972539300001', chips_count: 1, source: 'order', has_end: false },
    ]);
    const row = (await pool.query(`select address_street, address_city, address_zip, renter_terms_accepted_at is not null as rt from public.chip_orders where id = $1`, [o.id])).rows[0];
    expect(row).toEqual({ address_street: 'הרצל 1', address_city: 'חיפה', address_zip: '3300000', rt: true });
  });

  it('the window: never for an unpaid order; one block per person once paid', async () => {
    ids.itemA = await itemOf(ids.order, apt.a);
    ids.itemB = await itemOf(ids.order, apt.b);
    expect(await win.getChipOrderWindow(ids.itemA)).toBeNull();
    expect(await orders.markTestChipOrderPaid(ids.token)).toBe(ids.order);
    const w = (await win.getChipOrderWindow(ids.itemB))!;
    expect(w.holders.map((h) => [h.full_name, h.source, h.chips_count])).toEqual([['דנה כהן', 'order', 2], ['שרה לוי', 'order', 2], ['דנה כהן', 'order', 1]]);
    expect(w.clicked_item_id).toBe(ids.itemB);
    expect(w.order_all_linked).toBe(false);
    ids.h0 = w.holders[0].id!;
    ids.h1 = w.holders[1].id!;
    ids.h2 = w.holders[2].id!;
  });

  it('ONE save issues for both apartments, each chip linked to its line AND its person', async () => {
    const res = await win.saveChipOrderWindow(ids.order, {
      holders: [
        { id: ids.h0, item_id: ids.itemA, role: 'owner', full_name: 'דנה כהן', phone: '0539300001', email: 'dana@example.test',
          new_chips: [{ number: num(1), chip_type: 'physical' }, { number: num(2), chip_type: 'app' }] },
        { id: ids.h2, item_id: ids.itemB, role: 'owner', full_name: 'דנה כהן', phone: '0539300001', email: null,
          new_chips: [{ number: num(3), chip_type: 'physical' }] },
      ],
      note: 'הערה פנימית',
    }, admin);
    expect(res).toEqual({ issued: 3, updated: 0 });
    const chips = (await pool.query(
      `select chip_number, chip_type, order_item_id, order_holder_id, holder_name, resident_role from public.chips where chip_number = any($1::text[]) order by chip_number`,
      [[num(1), num(2), num(3)]])).rows;
    expect(chips.map((c) => [c.chip_number, c.chip_type, c.order_item_id, c.order_holder_id])).toEqual([
      [num(1), 'physical', ids.itemA, ids.h0], [num(2), 'app', ids.itemA, ids.h0], [num(3), 'physical', ids.itemB, ids.h2],
    ]);
    const w = (await win.getChipOrderWindow(ids.itemA))!;
    expect(w.order.internal_note).toBe('הערה פנימית');
    expect(w.holders[0].chips.map((c) => c.chip_number)).toEqual([num(1), num(2)]);
    expect(w.items.find((i) => i.id === ids.itemB)!.chips_linked).toBe(1);
  });

  it('a holder edit reaches the holder line and its chips (with a chip event)', async () => {
    await win.saveChipOrderWindow(ids.order, {
      holders: [{ id: ids.h0, item_id: ids.itemA, role: 'owner', full_name: 'דנה כהן-לוי', phone: '0539300009', email: '', new_chips: [] }],
    }, admin);
    const h = (await pool.query(`select full_name, phone, email from public.chip_order_holders where id = $1`, [ids.h0])).rows[0];
    expect(h).toEqual({ full_name: 'דנה כהן-לוי', phone: '+972539300009', email: null });
    const chips = (await pool.query(`select holder_name from public.chips where order_holder_id = $1`, [ids.h0])).rows;
    expect(chips.every((c) => c.holder_name === 'דנה כהן-לוי')).toBe(true);
  });

  it('a staff holder is never priced; it can be removed only while it has no chip', async () => {
    const before = (await pool.query(`select total::float8 as t from public.chip_orders where id = $1`, [ids.order])).rows[0].t;
    await win.saveChipOrderWindow(ids.order, {
      holders: [
        { id: null, item_id: ids.itemA, role: 'other', full_name: 'מטפלת סיעודית', phone: null, email: null, new_chips: [{ number: num(4), chip_type: 'physical' }] },
        { id: null, item_id: ids.itemA, role: 'tenant', full_name: 'בן משפחה', phone: null, email: null, new_chips: [] },
      ],
    }, admin);
    const staff = (await pool.query(`select id, full_name, source, chips_count from public.chip_order_holders where order_id = $1 and source = 'staff' order by position`, [ids.order])).rows;
    expect(staff.map((s) => [s.full_name, s.chips_count])).toEqual([['מטפלת סיעודית', 0], ['בן משפחה', 0]]);
    expect((await pool.query(`select total::float8 as t from public.chip_orders where id = $1`, [ids.order])).rows[0].t).toBe(before);
    await expect(win.saveChipOrderWindow(ids.order, { holders: [], removedHolderIds: [staff[0].id] }, admin)).rejects.toThrow(win.WindowInputError);
    await win.saveChipOrderWindow(ids.order, { holders: [], removedHolderIds: [staff[1].id] }, admin);
    expect((await pool.query(`select count(*)::int as n from public.chip_order_holders where id = $1`, [staff[1].id])).rows[0].n).toBe(0);
    await expect(win.saveChipOrderWindow(ids.order, { holders: [], removedHolderIds: [ids.h1] }, admin)).rejects.toThrow(win.WindowInputError);
  });

  it('a number another active chip holds → nothing is saved, the block is named', async () => {
    const err = await win.saveChipOrderWindow(ids.order, {
      holders: [
        { id: ids.h1, item_id: ids.itemA, role: 'tenant', full_name: 'שרה לוי', phone: '0539300002', email: null, new_chips: [{ number: num(9), chip_type: 'physical' }] },
        { id: ids.h2, item_id: ids.itemB, role: 'owner', full_name: 'דנה כהן', phone: '0539300001', email: null, new_chips: [{ number: num(1), chip_type: 'physical' }] },
      ],
    }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(win.WindowChipConflictError);
    expect((err as InstanceType<typeof win.WindowChipConflictError>).holderIndex).toBe(1);
    expect((await pool.query(`select count(*)::int as n from public.chips where chip_number = $1`, [num(9)])).rows[0].n).toBe(0);
  });

  it('an order from before 20/11 has one block per apartment, stored as a holder line on its first save; earlier chips match by phone', async () => {
    // An earlier chip of the same person in apartment C, outside any order.
    await issueChipGroups({ contact_id: ids.c, groups: [{ resident_role: 'other', holder_name: 'יוסי לגסי', holder_phone: '0539300077', chip_type: 'physical', numbers: [num(7)] }] }, admin);
    const o = await orders.createChipOrder(
      { fullName: 'יוסי לגסי', phoneE164: '+972539300077', email: 'y@example.test', address: 'x 1', role: 'owner', ip: null, isTest: true, phoneVerified: false,
        lines: [{ apartmentNumber: apt.c, chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(o.id);
    const t = (await pool.query<{ t: string }>(`select tracking_token as t from public.chip_orders where id = $1`, [o.id])).rows[0]!.t;
    await orders.markTestChipOrderPaid(t);
    const itemC = await itemOf(o.id, apt.c);
    const w = (await win.getChipOrderWindow(itemC))!;
    expect(w.holders).toHaveLength(1);
    expect(w.holders[0]).toMatchObject({ id: null, source: 'legacy', full_name: 'יוסי לגסי', chips_count: 1 });
    expect(w.holders[0].existing.map((c) => c.chip_number)).toEqual([num(7)]);
    await win.saveChipOrderWindow(o.id, {
      holders: [{ id: null, legacy: true, item_id: itemC, role: 'owner', full_name: 'יוסי לגסי', phone: '0539300077', email: null, new_chips: [{ number: num(8), chip_type: 'physical' }] }],
    }, admin);
    const w2 = (await win.getChipOrderWindow(itemC))!;
    expect(w2.holders).toHaveLength(1);
    expect(w2.holders[0]).toMatchObject({ source: 'order', chips_count: 1 });
    expect(w2.holders[0].chips.map((c) => c.chip_number)).toEqual([num(8)]);
    expect(w2.order_all_linked).toBe(true);
    expect(await win.listActiveChipIdsOfTestOrder(o.id)).toHaveLength(1);
  });
});

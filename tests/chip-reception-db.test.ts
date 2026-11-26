import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Issuing a chip at the reception (25/11/2026) on the DB, against a throwaway
// database (WA_TEST_DATABASE_URL), never prod. "הנפק צ׳יפ" — the issue window
// with no order — settles the NEW chips of a save (the card — paid first, in
// its own flow — is not tested here):
//   · cash ('cash') or a bank transfer ('bank_transfer', 26/11/2026 — until
//     then one option, stored 'cash_transfer') → a chip order of its own
//     (source 'reception'), linked to its people and chips exactly like a web
//     order, born paid and stored collected, with the payment on record, ONE
//     Morning invoice row queued in the same transaction, and no message to
//     anyone;
//   · no charge → no order at all; the details are kept on a reception record.
// And: a payment method is required for new chips only, the amount is the
// server's (chips × the price it was handed), a refused save leaves nothing
// behind — no chip, no order, no audit row — the audit rows of a save are
// written with it in one transaction, two people cannot hide under one block
// number, a lease of a web order cannot be tied to a chip, and a lease can
// never be written through the generic chip PATCH.
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

const reception = await import('@/lib/db/chipReception');
const orders = await import('@/lib/db/chipOrders');
const win = await import('@/lib/db/chipOrderWindow');
const chips = await import('@/lib/db/chips');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');
const { EMPTY_RECEPTION_ORDERER } = await import('@/lib/chipOrders/reception');

const tag = String(Date.now()).slice(-6);
const apt = { paid: `994${tag}1`, free: `994${tag}2`, edge: `994${tag}3`, web: `994${tag}4` };
/** `orders` — rows this file inserted straight, with no apartment line (removed by these ids). */
const made = { contacts: [] as string[], orders: [] as string[] };
/** The Morning document rows of an order, oldest first. */
const documentsOf = async (orderId: string) => (await pool.query(
  `select kind, payment_key, amount::float8 as amount, payment_method, status, credit_of
     from public.chip_order_documents where order_id = $1 order by created_at`, [orderId])).rows;
/** Document rows block deleting their order (FK restrict): credits first, then the rest — by the order's id. */
async function dropDocumentsOf(orderId: string) {
  await pool.query(`delete from public.chip_order_documents where order_id = $1 and credit_of is not null`, [orderId]);
  await pool.query(`delete from public.chip_order_documents where order_id = $1`, [orderId]);
}
const ids: Record<string, string> = {};
let admin: { id: string; name: string };
const num = (n: number) => `R${tag}${n}`;
const madeLeases: string[] = [];
/** A lease as POST /api/chips/leases leaves it: the file's reference, and its
 *  row in the lease registry (25/11/2026) — a save refuses a key that has
 *  none, since that is what a purged file looks like. */
async function lease() {
  const ref = { key: `${randomUUID()}.pdf`, name: 'חוזה שכירות.pdf', mime: 'application/pdf', size: 2048 };
  await pool.query(`insert into public.chip_lease_uploads (object_key, uploaded_by) values ($1, $2)`, [ref.key, admin.id]);
  madeLeases.push(ref.key);
  return ref;
}
const PRICE = 50;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await pool.query<T>(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);
const ordersOf = (contactId: string) =>
  count(`select count(*) as n from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = $1`, [contactId]);
const chipsOf = (contactId: string) => count(`select count(*) as n from public.chips where contact_id = $1`, [contactId]);
const recordsOf = (contactId: string) => count(`select count(*) as n from public.chip_reception_records where contact_id = $1`, [contactId]);
/** The audit rows the reception wrote about an apartment, oldest first. */
const trailOf = async (contactId: string) => (await pool.query<{ action: string; entity_type: string; entity_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
  `select action, entity_type, entity_id, actor_user_id, metadata from public.audit_log
    where metadata->>'source' = 'reception' and metadata->>'contact_id' = $1 order by created_at, action`, [contactId])).rows;

d('issuing a chip at the reception, on the DB', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    for (const [k, n] of Object.entries(apt)) {
      const r = await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone, tenant_name, tenant_phone)
         values ($1, 'בעלים רשום', '0539322110', 'שוכר רשום', '0539322111') returning id`, [n]);
      made.contacts.push(r.rows[0]!.id);
      ids[k] = r.rows[0]!.id;
    }
  });

  afterAll(async () => {
    if (!pool) return;
    const rows = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [made.contacts])).rows;
    for (const c of rows) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    // The orders and the records of THESE apartments only (the contact ids are this file's own).
    const mine = (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`,
      [made.contacts])).rows;
    for (const id of [...mine.map((o) => o.id), ...made.orders]) {
      await dropDocumentsOf(id);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of made.contacts) await pool.query(`delete from public.chip_reception_records where contact_id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.audit_log where metadata->>'source' = 'reception' and metadata->>'contact_id' = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const key of madeLeases) await pool.query(`delete from public.chip_lease_uploads where object_key = $1`, [key]);
    await pool.end();
  });

  it('cash: ONE order of the reception — paid, collected, its payment on record, its Morning invoice queued, one holder line per block, the chips linked to both; nobody is notified', async () => {
    const rentersLease = await lease();
    const res = await reception.saveReceptionWindow(
      {
        contact_id: ids.paid!,
        notes: 'נמסר לשומר',
        groups: [
          // One person, cards AND an app chip: two groups of one block.
          { resident_role: 'other', holder_name: 'אורח ראשון', holder_phone: '0539322221', holder_email: 'guest@example.test', chip_type: 'physical', numbers: [num(1), num(2)], block: 0 },
          { resident_role: 'other', holder_name: 'אורח ראשון', holder_phone: '0539322221', holder_email: 'guest@example.test', chip_type: 'app', numbers: [num(3)], block: 0 },
          // The registry's renter, with a lease: the name and the phone come from the tenants list.
          { resident_role: 'tenant', chip_type: 'physical', numbers: [num(4)], block: 1, lease: rentersLease, lease_end_date: '2027-06-30' },
        ],
      },
      {
        orderer: { name: 'משלם בדיקה', phone: '0539322229', email: 'pay@example.test', street: 'הרצל 5', city: 'חיפה', zip: '3303105' },
        payment: { method: 'cash', amount: 200 },
      },
      PRICE,
      admin,
    );
    expect(res.record).toBeNull();
    expect(res.items).toHaveLength(4);
    expect(res.order).toMatchObject({ total: 200, chips: 4, unit_price: PRICE, method: 'cash' });
    const orderId = res.order!.id;
    // The Morning document of the payment, queued in the save's own transaction: ONE invoice row.
    expect(await documentsOf(orderId)).toEqual([
      { kind: 'invoice', payment_key: `reception:${orderId}`, amount: 200, payment_method: 'cash', status: 'pending', credit_of: null },
    ]);

    const o = await one<Record<string, unknown>>(
      `select source, status, full_name, phone_e164, email, address, address_street, address_city, address_zip, role, total::float8 as total,
              is_test, phone_verified, payment_method, payment_recorded_by, payment_recorded_by_name, internal_note,
              grow_process_id, grow_transaction_id, invoice_url, due_at,
              paid_at is not null as paid, ready_at is not null as ready, collected_at is not null as collected,
              payment_recorded_at is not null as recorded, length(tracking_token) >= 32 as token
         from public.chip_orders where id = $1`, [orderId]);
    expect(o).toEqual({
      source: 'reception', status: 'collected', full_name: 'משלם בדיקה', phone_e164: '+972539322229', email: 'pay@example.test',
      address: 'הרצל 5, חיפה 3303105', address_street: 'הרצל 5', address_city: 'חיפה', address_zip: '3303105',
      role: 'other', total: 200, is_test: false, phone_verified: true,
      payment_method: 'cash', payment_recorded_by: admin.id, payment_recorded_by_name: admin.name, internal_note: 'נמסר לשומר',
      grow_process_id: null, grow_transaction_id: null, invoice_url: null, due_at: null,
      paid: true, ready: true, collected: true, recorded: true, token: true,
    });

    const items = (await pool.query(
      `select id, contact_id, apartment_number, chips_count, unit_price::float8 as unit_price, threshold, price_above::float8 as price_above,
              line_total::float8 as line_total from public.chip_order_items where order_id = $1`, [orderId])).rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ contact_id: ids.paid, apartment_number: apt.paid, chips_count: 4, unit_price: 50, threshold: 4, price_above: 50, line_total: 200 });
    const itemId = items[0]!.id as string;

    const holders = (await pool.query(
      `select id, source, role, full_name, phone, email, chips_count, lease_file_key, to_char(lease_end_date, 'YYYY-MM-DD') as lease_end_date
         from public.chip_order_holders where order_id = $1 order by position`, [orderId])).rows;
    expect(holders.map((h) => ({ ...h, id: undefined }))).toEqual([
      { id: undefined, source: 'reception', role: 'other', full_name: 'אורח ראשון', phone: '+972539322221', email: 'guest@example.test', chips_count: 3, lease_file_key: null, lease_end_date: null },
      // The lease itself stays on the chips; the holder line keeps its end date.
      { id: undefined, source: 'reception', role: 'tenant', full_name: 'שוכר רשום', phone: '+972539322111', email: null, chips_count: 1, lease_file_key: null, lease_end_date: '2027-06-30' },
    ]);

    const saved = (await pool.query(
      `select chip_number, chip_type, status, resident_role, holder_name, holder_email, order_item_id, order_holder_id, reception_record_id,
              lease_file_key, lease_file_name, to_char(lease_end_date, 'YYYY-MM-DD') as lease_end_date, notes,
              issuance_fee, fee_charged
         from public.chips where contact_id = $1 order by chip_number`, [ids.paid])).rows;
    expect(saved.map((c) => c.chip_number)).toEqual([num(1), num(2), num(3), num(4)]);
    for (const c of saved) {
      expect(c).toMatchObject({ status: 'active', order_item_id: itemId, reception_record_id: null, notes: 'נמסר לשומר', issuance_fee: null, fee_charged: false });
    }
    for (const c of saved.slice(0, 3)) {
      expect(c).toMatchObject({ resident_role: 'other', holder_name: 'אורח ראשון', holder_email: 'guest@example.test', order_holder_id: holders[0]!.id, lease_file_key: null });
    }
    expect(saved[2]!.chip_type).toBe('app');
    expect(saved[3]).toMatchObject({
      resident_role: 'tenant', holder_name: 'שוכר רשום', order_holder_id: holders[1]!.id,
      lease_file_key: rentersLease.key, lease_file_name: rentersLease.name, lease_end_date: '2027-06-30',
    });

    // No message to anyone, and no reception record: the order IS the record.
    expect(await count(`select count(*) as n from public.chip_order_notifications where order_id = $1`, [orderId])).toBe(0);
    expect(await recordsOf(ids.paid!)).toBe(0);

    // The order and its payment are in the audit trail — written in the save's
    // own transaction — with no person's name in them.
    const trail = await trailOf(ids.paid!);
    expect(trail.map((t) => [t.action, t.entity_type, t.entity_id, t.actor_user_id])).toEqual([
      ['created', 'chip_order', orderId, admin.id],
      ['payment_recorded', 'chip_order', orderId, admin.id],
    ]);
    expect(trail[1]!.metadata).toEqual({
      source: 'reception', contact_id: ids.paid, apartment_number: apt.paid, chips: 4, unit_price: PRICE,
      order_number: res.order!.order_number, method: 'cash', amount: 200,
    });
    expect(JSON.stringify(trail)).not.toMatch(/משלם|אורח|שוכר|0539322/);

    // The window of that order: its people, the renter's lease read from the chips, the payment.
    const w = (await win.getChipOrderWindow(itemId))!;
    expect(w.order).toMatchObject({
      source: 'reception', status: 'collected', payment_method: 'cash', payment_recorded_by_name: admin.name,
      full_name: 'משלם בדיקה', total: 200, internal_note: 'נמסר לשומר',
    });
    expect(w.order.payment_recorded_at).toBeTruthy();
    expect(w.order.documents).toEqual([expect.objectContaining({ kind: 'invoice', status: 'pending', amount: 200, number: null, url: null })]);
    expect(w.holders.map((h) => [h.source, h.full_name, h.chips_count, h.chips.length])).toEqual([
      ['reception', 'אורח ראשון', 3, 3],
      ['reception', 'שוכר רשום', 1, 1],
    ]);
    expect(w.holders[1]).toMatchObject({ lease_file_key: rentersLease.key, lease_file_name: rentersLease.name, lease_end_date: '2027-06-30' });
    expect(w.items[0]).toMatchObject({ chips_count: 4, chips_linked: 4 });

    // It is closed: a save of that window is refused.
    await expect(win.saveChipOrderWindow(orderId, { holders: [], note: 'אחר כך' }, admin, PRICE)).rejects.toMatchObject({ message: 'not_open' });

    // What the block of the chips shows again.
    const records = await reception.listReceptionRecords(ids.paid!);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'order', ref: itemId, order_number: res.order!.order_number, orderer_name: 'משלם בדיקה', orderer_phone: '+972539322229',
      orderer_email: 'pay@example.test', address: 'הרצל 5, חיפה 3303105', chips_count: 4, amount: 200, by_name: admin.name,
      cancelled: false, payment_method: 'cash',
    });
  });

  it('the Orders tab lists a reception order although it is collected — after every open order — and a collected WEB order stays out', async () => {
    const web = await orders.createChipOrder(
      {
        fullName: 'מזמין מהאתר', phoneE164: '+972539322300', email: 'web@example.test', address: 'הרצל 1, חיפה 3300000', role: 'owner',
        ip: null, isTest: true, phoneVerified: false,
        rows: [{ role: 'owner', fullName: 'מזמין מהאתר', apartmentNumber: apt.web, chipsCount: 1, phoneE164: '+972539322300', email: null, lease: null, leaseEndDate: null }],
      },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    await orders.markTestChipOrderPaid(web.trackingToken);

    const rows = await orders.listOpenChipOrderRows();
    const mine = rows.filter((r) => r.apartment_number === apt.paid || r.apartment_number === apt.web);
    expect(mine.map((r) => [r.apartment_number, r.source, r.status])).toEqual([
      [apt.web, 'web', 'paid'],
      [apt.paid, 'reception', 'collected'],
    ]);
    const row = mine[1]!;
    expect(row).toMatchObject({
      full_name: 'משלם בדיקה', phone_e164: '+972539322229', role: 'other', chips_count: 4, chips_linked: 4, line_total: 200,
      is_test: false, phone_verified: true, has_failed_notification: false, due_at: null,
    });
    // Its people are its holder lines — the orderer is not repeated in front of them.
    expect(row.people).toEqual(['אורח ראשון', 'שוכר רשום']);
    // Every open row comes before every collected one.
    const firstCollected = rows.findIndex((r) => r.status === 'collected');
    expect(rows.slice(firstCollected).every((r) => r.status === 'collected' && r.source === 'reception')).toBe(true);

    // A web order that is collected leaves the tab, as always.
    await pool.query(`update public.chip_orders set status = 'collected', collected_at = now() where id = $1`, [web.id]);
    expect((await orders.listOpenChipOrderRows()).some((r) => r.apartment_number === apt.web)).toBe(false);
  });

  it('no charge: NO order — a reception record keeps the details, and the chips point at it', async () => {
    const res = await reception.saveReceptionWindow(
      {
        contact_id: ids.free!,
        notes: null,
        groups: [{ resident_role: 'other', holder_name: 'אורח חינם', holder_email: 'free@example.test', chip_type: 'physical', numbers: [num(10), num(11)], block: 0 }],
      },
      { orderer: { ...EMPTY_RECEPTION_ORDERER, name: 'אורח חינם', street: 'הנמל 3' }, payment: { method: 'none', amount: 0 } },
      PRICE,
      admin,
    );
    expect(res.order).toBeNull();
    expect(res.record).toMatchObject({ chips: 2, unit_price: PRICE });
    expect(await ordersOf(ids.free!)).toBe(0);

    const r = await one<Record<string, unknown>>(
      `select apartment_number, orderer_name, orderer_phone, orderer_email, address_street, address_city, address_zip, chips_count,
              unit_price::float8 as unit_price, created_by, created_by_name from public.chip_reception_records where id = $1`, [res.record!.id]);
    expect(r).toEqual({
      apartment_number: apt.free, orderer_name: 'אורח חינם', orderer_phone: null, orderer_email: null, address_street: 'הנמל 3',
      address_city: null, address_zip: null, chips_count: 2, unit_price: 50, created_by: admin.id, created_by_name: admin.name,
    });
    const saved = (await pool.query(
      `select reception_record_id, order_item_id, order_holder_id, holder_email from public.chips where contact_id = $1`, [ids.free])).rows;
    expect(saved).toHaveLength(2);
    for (const c of saved) expect(c).toEqual({ reception_record_id: res.record!.id, order_item_id: null, order_holder_id: null, holder_email: 'free@example.test' });

    expect((await trailOf(ids.free!)).map((t) => [t.action, t.entity_type, t.entity_id, t.metadata])).toEqual([
      ['issued_no_charge', 'chip_reception_record', res.record!.id, {
        source: 'reception', contact_id: ids.free, apartment_number: apt.free, chips: 2, unit_price: PRICE, method: 'none', amount: 0,
      }],
    ]);

    expect(await reception.listReceptionRecords(ids.free!)).toEqual([
      expect.objectContaining({
        kind: 'record', ref: res.record!.id, order_number: null, orderer_name: 'אורח חינם', orderer_phone: null, orderer_email: null,
        address: 'הנמל 3', chips_count: 2, amount: 0, by_name: admin.name,
      }),
    ]);
  });

  it('new chips with no payment method are refused, and nothing is saved', async () => {
    const before = await chipsOf(ids.edge!);
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [{ resident_role: 'other', holder_name: 'בלי תשלום', chip_type: 'physical', numbers: [num(20)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null },
      PRICE,
      admin,
    )).rejects.toMatchObject({ name: 'ReceptionError', code: 'payment_required' });
    expect(await chipsOf(ids.edge!)).toBe(before);
    expect(await ordersOf(ids.edge!)).toBe(0);
    expect(await recordsOf(ids.edge!)).toBe(0);
  });

  it('the amount is the server\'s: a sum the window showed that is not chips × the price is refused — with the right sum, and nothing saved', async () => {
    const group = { resident_role: 'other' as const, holder_name: 'סכום שגוי', chip_type: 'physical' as const, numbers: [num(21), num(22)] };
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [group] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: 150 } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'amount_mismatch', expectedAmount: 100 });
    // The price went up while the window was open: the old sum is not the sum any more.
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [group] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'bank_transfer', amount: 100 } },
      70,
      admin,
    )).rejects.toMatchObject({ code: 'amount_mismatch', expectedAmount: 140 });
    expect(await chipsOf(ids.edge!)).toBe(0);
    expect(await ordersOf(ids.edge!)).toBe(0);
  });

  it('a save that costs nothing cannot be "paid"; more chips than one order line holds cannot either; a one-letter name makes no order', async () => {
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [{ resident_role: 'other', holder_name: 'חינם בטעות', chip_type: 'physical', numbers: [num(23)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'bank_transfer', amount: 0 } },
      0,
      admin,
    )).rejects.toMatchObject({ code: 'nothing_to_charge' });

    const many = Array.from({ length: 26 }, (_, i) => num(100 + i));
    await expect(reception.saveReceptionWindow(
      {
        contact_id: ids.edge!,
        groups: [
          { resident_role: 'other', holder_name: 'הרבה צ׳יפים', chip_type: 'physical', numbers: many, block: 0 },
          { resident_role: 'other', holder_name: 'הרבה צ׳יפים', chip_type: 'app', numbers: many.map((n) => `${n}A`), block: 0 },
        ],
      },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: 52 * PRICE } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'too_many_chips' });

    await expect(reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [{ resident_role: 'other', holder_name: 'א', chip_type: 'physical', numbers: [num(24)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: PRICE } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'name_too_short' });

    expect(await chipsOf(ids.edge!)).toBe(0);
    expect(await ordersOf(ids.edge!)).toBe(0);
  });

  it('a number another chip holds refuses the whole paid save: no chip, and no order left behind', async () => {
    await expect(reception.saveReceptionWindow(
      {
        contact_id: ids.edge!,
        groups: [{ resident_role: 'other', holder_name: 'מספר תפוס', chip_type: 'physical', numbers: [num(25), num(1)] }], // num(1) is active on another apartment
      },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'bank_transfer', amount: 100 } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ name: 'ChipNumberTakenError', chipNumber: num(1), groupIndex: 0 });
    expect(await chipsOf(ids.edge!)).toBe(0);
    expect(await ordersOf(ids.edge!)).toBe(0);
    // Every refusal above rolled its whole transaction back: no trail of a save that never was,
    // and no document of a payment that never was.
    expect(await trailOf(ids.edge!)).toEqual([]);
    expect(await count(
      `select count(*) as n from public.chip_order_documents d join public.chip_order_items i on i.order_id = d.order_id where i.contact_id = $1`,
      [ids.edge],
    )).toBe(0);
  });

  it('two people cannot hide under one block number: groups are one person only when role, name and phone agree', async () => {
    const res = await reception.saveReceptionWindow(
      {
        contact_id: ids.web!,
        groups: [
          { resident_role: 'other', holder_name: 'ראשון בבלוק', holder_phone: '0539322501', chip_type: 'physical', numbers: [num(40)], block: 7 },
          { resident_role: 'other', holder_name: 'ראשון בבלוק', holder_phone: '0539322501', chip_type: 'app', numbers: [num(41)], block: 7 },
          // The same block number, another person: a line of its own, under its own name.
          { resident_role: 'other', holder_name: 'שני בבלוק', holder_phone: '0539322502', chip_type: 'physical', numbers: [num(42)], block: 7 },
        ],
      },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'bank_transfer', amount: 3 * PRICE } },
      PRICE,
      admin,
    );
    const holders = (await pool.query(
      `select h.full_name, h.chips_count, array(select c.chip_number from public.chips c where c.order_holder_id = h.id order by c.chip_number) as numbers
         from public.chip_order_holders h where h.order_id = $1 order by h.position`, [res.order!.id])).rows;
    expect(holders).toEqual([
      { full_name: 'ראשון בבלוק', chips_count: 2, numbers: [num(40), num(41)] },
      { full_name: 'שני בבלוק', chips_count: 1, numbers: [num(42)] },
    ]);
    // A bank transfer is stored as one — and its document says so (Morning needs the real payment type).
    expect(res.order).toMatchObject({ method: 'bank_transfer', total: 3 * PRICE });
    expect(await one(`select payment_method from public.chip_orders where id = $1`, [res.order!.id])).toEqual({ payment_method: 'bank_transfer' });
    expect(await documentsOf(res.order!.id)).toEqual([
      { kind: 'invoice', payment_key: `reception:${res.order!.id}`, amount: 3 * PRICE, payment_method: 'bank_transfer', status: 'pending', credit_of: null },
    ]);
    // …and each of them is checked: a one-letter name behind a shared block number is refused.
    await expect(reception.saveReceptionWindow(
      {
        contact_id: ids.web!,
        groups: [
          { resident_role: 'other', holder_name: 'ראשון בבלוק', chip_type: 'physical', numbers: [num(43)], block: 1 },
          { resident_role: 'other', holder_name: 'ב', chip_type: 'physical', numbers: [num(44)], block: 1 },
        ],
      },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: 2 * PRICE } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'name_too_short' });
  });

  it('a name longer than an order stores is refused with a reason — never a failed insert; a registry phone the tables would refuse is left out', async () => {
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.web!, groups: [{ resident_role: 'other', holder_name: 'א'.repeat(121), chip_type: 'physical', numbers: [num(45)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: PRICE } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'name_too_long' });

    // A renter whose phone in the tenants list is a stub: the save goes through, the holder line has no phone.
    await pool.query(`update public.contacts set tenant_phone = '12' where id = $1`, [ids.web]);
    const res = await reception.saveReceptionWindow(
      { contact_id: ids.web!, groups: [{ resident_role: 'tenant', chip_type: 'physical', numbers: [num(46)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: PRICE } },
      PRICE,
      admin,
    );
    expect(await one(`select full_name, phone from public.chip_order_holders where order_id = $1`, [res.order!.id]))
      .toEqual({ full_name: 'שוכר רשום', phone: null });
  });

  it('a lease of a web order cannot be tied to a chip from here — as a new chip\'s lease or as an edit', async () => {
    // A web order of this apartment whose renter line holds a lease.
    const theirs = `${randomUUID()}.pdf`;
    const web = await orders.createChipOrder(
      {
        fullName: 'שוכר מהאתר', phoneE164: '+972539322600', email: 'renter.web@example.test', address: 'הרצל 1, חיפה 3300000', role: 'tenant',
        ip: null, isTest: true, phoneVerified: false, renterTermsAccepted: true,
        rows: [{
          role: 'tenant', fullName: 'שוכר מהאתר', apartmentNumber: apt.web, chipsCount: 1, phoneE164: '+972539322600', email: null,
          lease: { objectKey: theirs, fileName: 'lease.pdf', mime: 'application/pdf', size: 100 }, leaseEndDate: '2030-01-31',
        }],
      },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    expect(web.id).toBeTruthy();
    const stolen = { key: theirs, name: 'שלי.pdf', mime: 'application/pdf', size: 100 };

    const before = await chipsOf(ids.web!);
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.web!, groups: [{ resident_role: 'other', holder_name: 'לוקח חוזה', chip_type: 'physical', numbers: [num(47)], lease: stolen }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'none', amount: 0 } },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'lease_in_use' });
    expect(await chipsOf(ids.web!)).toBe(before);

    const chip = await one<{ id: string }>(`select id from public.chips where chip_number = $1`, [num(46)]);
    await expect(reception.saveReceptionWindow(
      { contact_id: ids.web!, groups: [], updates: [{ id: chip.id, lease: stolen }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null },
      PRICE,
      admin,
    )).rejects.toMatchObject({ code: 'lease_in_use' });
    expect(await one(`select lease_file_key from public.chips where id = $1`, [chip.id])).toEqual({ lease_file_key: null });
  });

  it('an orderer who left nothing: the order takes the first chip holder\'s name, and has no phone, email or address', async () => {
    const res = await reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [num(30)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: PRICE } },
      PRICE,
      admin,
    );
    const o = await one<Record<string, unknown>>(
      `select full_name, phone_e164, email, address, role, status, total::float8 as total from public.chip_orders where id = $1`, [res.order!.id]);
    expect(o).toEqual({ full_name: 'בעלים רשום', phone_e164: null, email: null, address: null, role: 'owner', status: 'collected', total: 50 });
    // The holder line is the registry's owner, phone and all.
    const h = await one<Record<string, unknown>>(`select source, full_name, phone, chips_count from public.chip_order_holders where order_id = $1`, [res.order!.id]);
    expect(h).toEqual({ source: 'reception', full_name: 'בעלים רשום', phone: '+972539322110', chips_count: 1 });
  });

  it('the longest address the window lets through still makes an order: the one-line address is cut to its column, the parts keep everything', async () => {
    const street = `${'רחוב ארוך מאוד '.repeat(13)}12345`.slice(0, 200);
    const city = 'עיר ששמה ארוך במיוחד '.repeat(5).slice(0, 100).trim();
    expect(street).toHaveLength(200);
    const res = await reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [{ resident_role: 'other', holder_name: 'כתובת ארוכה', chip_type: 'physical', numbers: [num(31)] }] },
      { orderer: { ...EMPTY_RECEPTION_ORDERER, street, city, zip: '3303105' }, payment: { method: 'bank_transfer', amount: PRICE } },
      PRICE,
      admin,
    );
    const o = await one<{ address: string; address_street: string; address_city: string; address_zip: string }>(
      `select address, address_street, address_city, address_zip from public.chip_orders where id = $1`, [res.order!.id]);
    expect(o.address).toHaveLength(300);
    expect(o.address.startsWith(street)).toBe(true);
    expect(o).toMatchObject({ address_street: street, address_city: city, address_zip: '3303105' });
  });

  it('editing saved chips alone needs no payment: the email, the lease and its end date reach the chip, with one event that never names the storage key', async () => {
    const chip = await one<{ id: string }>(`select id from public.chips where chip_number = $1`, [num(30)]);
    const newLease = await lease();
    const res = await reception.saveReceptionWindow(
      {
        contact_id: ids.edge!,
        groups: [],
        updates: [{ id: chip.id, holder_email: 'owner@example.test', lease: newLease, lease_end_date: '2028-01-31' }],
      },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null },
      PRICE,
      admin,
    );
    expect(res).toMatchObject({ order: null, record: null });
    expect(res.updated).toHaveLength(1);
    expect(res.updated[0]).toMatchObject({ holder_email: 'owner@example.test', lease_file_key: newLease.key, lease_file_name: newLease.name, lease_end_date: '2028-01-31' });
    const event = await one<{ new_value: Record<string, unknown> }>(
      `select new_value from public.chip_events where chip_id = $1 and event_type = 'note' order by created_at desc limit 1`, [chip.id]);
    expect(event.new_value).toEqual({ holder_email: 'owner@example.test', lease_file_name: newLease.name, lease_end_date: '2028-01-31' });
    expect(JSON.stringify(event.new_value)).not.toContain(newLease.key);

    // The same values again write nothing; a null lease takes it off the chip.
    const again = await reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [], updates: [{ id: chip.id, holder_email: 'owner@example.test', lease: newLease }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null }, PRICE, admin,
    );
    expect(again.updated).toHaveLength(1);
    expect(await count(`select count(*) as n from public.chip_events where chip_id = $1 and event_type = 'note'`, [chip.id])).toBe(1);
    await reception.saveReceptionWindow(
      { contact_id: ids.edge!, groups: [], updates: [{ id: chip.id, lease: null }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: null }, PRICE, admin,
    );
    expect(await one(`select lease_file_key, lease_file_name, holder_email from public.chips where id = $1`, [chip.id]))
      .toEqual({ lease_file_key: null, lease_file_name: null, holder_email: 'owner@example.test' });
  });

  it('the generic chip PATCH cannot set a lease or an email: both stay out of its whitelist', async () => {
    const chip = await one<{ id: string }>(`select id from public.chips where chip_number = $1`, [num(30)]);
    await chips.updateChip(chip.id, { lease_file_key: 'someone-elses.pdf', lease_file_name: 'x.pdf', holder_email: 'forged@example.test', reception_record_id: randomUUID() }, admin);
    expect(await one(`select lease_file_key, lease_file_name, holder_email, reception_record_id from public.chips where id = $1`, [chip.id]))
      .toEqual({ lease_file_key: null, lease_file_name: null, holder_email: 'owner@example.test', reception_record_id: null });
  });

  it('the two fee columns of the removed fields are written by nothing: not by a save of the window, not by the generic chip PATCH', async () => {
    const chip = await one<{ id: string; notes: string | null }>(`select id, notes from public.chips where chip_number = $1`, [num(30)]);
    // A caller that still sends them: the PATCH takes what it may (the note) and leaves the two columns as they were.
    const patched = await chips.updateChip(chip.id, { issuance_fee: 75, fee_charged: true, notes: 'הערה אחרי תיקון' }, admin);
    expect(patched).toMatchObject({ issuance_fee: null, fee_charged: false, notes: 'הערה אחרי תיקון' });
    expect(await one(`select issuance_fee, fee_charged, notes from public.chips where id = $1`, [chip.id]))
      .toEqual({ issuance_fee: null, fee_charged: false, notes: 'הערה אחרי תיקון' });
    // …and alone they are no change at all — no event is written for them.
    const before = await count(`select count(*) as n from public.chip_events where chip_id = $1`, [chip.id]);
    await chips.updateChip(chip.id, { issuance_fee: 75, fee_charged: true }, admin);
    expect(await count(`select count(*) as n from public.chip_events where chip_id = $1`, [chip.id])).toBe(before);
    // No chip of these fixtures — issued through the window, paid or free — carries a fee.
    expect(await count(
      `select count(*) as n from public.chips where contact_id = any($1::uuid[]) and (issuance_fee is not null or fee_charged)`,
      [Object.values(ids)],
    )).toBe(0);
  });

  it('the database keeps the two kinds apart: a web order still needs its phone, email and address; a reception order is never a test order', async () => {
    const base = `insert into public.chip_orders (full_name, role, status, total, tracking_token, paid_at, source, phone_e164, email, address, payment_method, payment_recorded_by_name, payment_recorded_at, is_test, grow_transaction_id)`;
    const token = () => randomUUID() + randomUUID();
    // A web order with no phone / email / address — refused, as before the reception existed.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'paid', 50, $1, now(), 'web', null, 'a@example.test', 'כתובת 1', null, null, null, false, 'x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_phone_e164_check' });
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'paid', 50, $1, now(), 'web', '+972539322400', null, 'כתובת 1', null, null, null, false, 'x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_email_check' });
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'paid', 50, $1, now(), 'web', '+972539322400', 'a@example.test', null, null, null, null, false, 'x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_address_check' });
    // …and a phone that is no Israeli mobile, as before.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'paid', 50, $1, now(), 'web', '048500184', 'a@example.test', 'כתובת 1', null, null, null, false, 'x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_phone_e164_check' });
    // A web order "paid" with no Grow transaction and no confirmed card charge — refused, as before (only a test
    // order, a reception order, or — since 26/11/2026 — a card charge the processor confirmed, card_status 'paid').
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'paid', 50, $1, now(), 'web', '+972539322400', 'a@example.test', 'כתובת 1', null, null, null, false, null)`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_paid_fields_check' });
    // A web order for a guest — refused: only the reception issues for a guest.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'other', 'paid', 50, $1, now(), 'web', '+972539322400', 'a@example.test', 'כתובת 1', null, null, null, false, 'x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_role_check' });
    // A reception order with no payment on record, or marked as a test — refused. Only a CARD
    // payment of the sandbox may be a test (26/11/2026); cash or a transfer never is.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'collected', 50, $1, now(), 'reception', null, null, null, null, null, null, false, null)`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_reception_check' });
    for (const method of ['cash', 'bank_transfer', 'cash_transfer']) {
      await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'collected', 50, $1, now(), 'reception', null, null, null, $2, 'מנהל', now(), true, null)`, [token(), method]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_reception_check' });
    }
    // …or carrying a Grow transaction.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'collected', 50, $1, now(), 'reception', null, null, null, 'cash', 'מנהל', now(), false, 'grow-x')`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_reception_check' });
    // And a payment method nobody knows.
    await expect(pool.query(`${base} values ('בדיקה אחת', 'owner', 'collected', 50, $1, now(), 'reception', null, null, null, 'cheque', 'מנהל', now(), false, null)`, [token()]))
      .rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_payment_method_check' });
    // The value of the orders recorded before the split still stands in the table (shown "מזומן או העברה").
    const legacy = await one<{ id: string }>(
      `${base} values ('בדיקה אחת', 'owner', 'collected', 50, $1, now(), 'reception', null, null, null, 'cash_transfer', 'מנהל', now(), false, null) returning id`,
      [token()],
    );
    made.orders.push(legacy.id);
    expect(await one(`select payment_method from public.chip_orders where id = $1`, [legacy.id])).toEqual({ payment_method: 'cash_transfer' });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { NextRequest } from 'next/server';
import type { Role } from '@/lib/permissions/constants';
import type { PickupOrder } from '@/lib/chipOrders/pickup';

// The guard's pickup screen ("מסירת צ׳יפים", 25/11/2026) through its REAL
// routes and the REAL role guards, against a throwaway database
// (WA_TEST_DATABASE_URL), never prod. Only the session is mocked — who is
// signed in — so requireChipPickup / requirePermission / requireAdmin decide
// exactly as they do in production.
//   · the list holds ONLY orders that are ready for pickup, and of each one
//     only what the guard needs: its number, its apartments, its people and
//     their active chip numbers. No price, amount, payment detail, email,
//     phone, address, lease or note is in the answer — checked by the exact
//     set of keys AND by looking for the fixtures' own values in the body;
//   · guard, admin and super admin get in; every other role is refused, also a
//     manager who holds every chips permission of the matrix;
//   · the guard is refused on every other chip endpoint;
//   · "נמסר": only an order that is ready; the person must be named and must
//     be a person of THAT order; who handed over, when and who collected are
//     stored on the order and audited in the same transaction;
//   · the management's "נאסף" may name the person, or nobody.
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

const h = vi.hoisted(() => ({
  user: null as null | { id: string; username: string; email: string | null; full_name: string | null; role: string },
}));
// Who is signed in — the one thing that is not real here.
vi.mock('@/lib/auth/session', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/session')>()),
  getSession: async () => (h.user ? { sid: 'test', user: h.user } : null),
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { void fn; },
}));
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined), afterOrderPaid: vi.fn(async () => undefined) }));

const { requireSeededAdmin } = await import('./db-fixtures');
const { issueChipGroups, deactivateChip } = await import('@/lib/db/chips');
const { saveReceptionWindow } = await import('@/lib/db/chipReception');
const { EMPTY_RECEPTION_ORDERER } = await import('@/lib/chipOrders/reception');
const { PICKUP_ORDERER_KEY } = await import('@/lib/chipOrders/pickup');

const pickupList = await import('@/app/api/chip-pickup/route');
const handover = await import('@/app/api/chip-pickup/[id]/handover/route');
const collected = await import('@/app/api/chip-orders/[id]/collected/route');

const tag = String(Date.now()).slice(-6);
const APT = (n: number) => `996${tag}${n}`;
const num = (n: number) => `K${tag}${n}`;

// Values that must never reach the guard — each one distinctive, so finding it
// in a response body cannot be a coincidence.
const SECRET = {
  email: `secret-mail-${tag}@example.test`,
  holderEmail: `secret-holder-${tag}@example.test`,
  address: `SENTINEL-ADDRESS-${tag}`,
  street: `SENTINEL-STREET-${tag}`,
  note: `SENTINEL-NOTE-${tag}`,
  leaseName: `SENTINEL-LEASE-${tag}.pdf`,
  leaseKey: `${randomUUID()}.pdf`,
  phoneLocal: `05393${tag.slice(-5)}`,
  unitPrice: 61.37,
};
const PHONE = `+9725393${tag.slice(-5)}`;

const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: Role }> = {};
const actor = (key: string) => ({ id: users[key]!.id, name: users[key]!.full_name ?? users[key]!.username });

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await pool.query<T>(sql, params)).rows[0] as T;
const as = (key: string | null) => { h.user = key ? users[key]! : null; };

interface Row { apt: string; role: 'owner' | 'tenant'; name: string; qty: number; lease?: boolean }

/** A PAID web order (what Grow's verified callback leaves) of the given rows:
 *  one line per apartment, one holder line per row — or none at all for an
 *  order of the kind made before 20/11/2026 (`legacy`). */
async function seedOrder(rows: Row[], opts: { isTest?: boolean; legacy?: boolean; name?: string } = {}) {
  const n = made.orders.length;
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  const o = await one<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at,
        grow_process_id, grow_transaction_id, address_street, address_city, address_zip, internal_note, is_test)
     values ($1, $2, $3, $4, 'owner', 'paid', $5, $6, now(), now() + interval '3 days', $7, $8, $9, 'חיפה', '3300000', $10, $11)
     returning id, order_number`,
    [
      opts.name ?? rows[0]!.name, PHONE, SECRET.email, SECRET.address, qty * SECRET.unitPrice, randomBytes(32).toString('base64url'),
      opts.isTest ? null : `pk-p-${tag}-${n}`, opts.isTest ? null : `pk-t-${tag}-${n}`, SECRET.street, SECRET.note, opts.isTest === true,
    ],
  );
  made.orders.push(o.id);
  const items: Record<string, string> = {};
  for (const apt of [...new Set(rows.map((r) => r.apt))]) {
    const q = rows.filter((r) => r.apt === apt).reduce((s, r) => s + r.qty, 0);
    items[apt] = (await one<{ id: string }>(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, $4, $5, $4, $5, $6, 'unassigned') returning id`,
      [o.id, made.contacts[apt], apt, q, SECRET.unitPrice, q * SECRET.unitPrice],
    )).id;
  }
  const holders: string[] = [];
  if (!opts.legacy) {
    for (const [position, r] of rows.entries()) {
      holders.push((await one<{ id: string }>(
        `insert into public.chip_order_holders
           (order_id, item_id, position, source, role, full_name, phone, email, chips_count, lease_file_key, lease_file_name, lease_end_date)
         values ($1, $2, $3, 'order', $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [o.id, items[r.apt], position, r.role, r.name, PHONE, SECRET.holderEmail, r.qty,
          r.lease ? SECRET.leaseKey : null, r.lease ? SECRET.leaseName : null, r.lease ? '2027-06-30' : null],
      )).id);
    }
  }
  return { id: o.id, orderNumber: o.order_number, items, holders };
}

/** Issues chips for one person of an order — linked to the order line and, when
 *  there is one, to the holder line. */
async function issue(apt: string, itemId: string, holderId: string | null, name: string, numbers: string[], type: 'physical' | 'app' = 'physical') {
  const r = await issueChipGroups(
    { contact_id: made.contacts[apt]!, groups: [{ resident_role: 'other', holder_name: name, chip_type: type, numbers, order_item_id: itemId, order_holder_id: holderId }] },
    actor('admin'),
  );
  return r.items.map((c) => c.id);
}

const ready = (orderId: string) => pool.query(`update public.chip_orders set status = 'ready', ready_at = now() where id = $1`, [orderId]);
const statusOf = async (orderId: string) => (await one<{ status: string }>(`select status from public.chip_orders where id = $1`, [orderId])).status;

async function list(): Promise<{ status: number; orders: PickupOrder[]; text: string }> {
  const res = await pickupList.GET();
  const text = await res.text();
  const body = JSON.parse(text) as { orders?: PickupOrder[] };
  return { status: res.status, orders: (body.orders ?? []).filter((o) => made.orders.includes(o.id)), text };
}

function hand(orderId: string, body: unknown) {
  return handover.POST(
    new Request(`http://local/api/chip-pickup/${orderId}/handover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orderId }) },
  );
}

function collect(orderId: string, body?: unknown) {
  return collected.POST(
    new Request(`http://local/api/chip-orders/${orderId}/collected`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orderId }) },
  );
}

const orderRow = (orderId: string) => one<{
  status: string; collected_at: Date | null; collected_by_name: string | null; collected_holder_id: string | null;
  handed_over_by: string | null; handed_over_by_name: string | null; handed_over_via: string | null;
  delivery_note: string | null; delivery_note_by: string | null; delivery_note_by_name: string | null; delivery_note_at: Date | null;
}>(
  `select status, collected_at, collected_by_name, collected_holder_id, handed_over_by, handed_over_by_name, handed_over_via,
          delivery_note, delivery_note_by, delivery_note_by_name, delivery_note_at
     from public.chip_orders where id = $1`,
  [orderId],
);
const trail = async (orderId: string) => (await pool.query<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
  `select action, actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 order by created_at`, [orderId])).rows;

d('the guard\'s pickup screen, on the DB and through its routes', () => {
  // The orders of the suite.
  let main: Awaited<ReturnType<typeof seedOrder>>; // ready: two apartments, three people + one the staff added
  let waiting: Awaited<ReturnType<typeof seedOrder>>; // paid, still being prepared
  let old: Awaited<ReturnType<typeof seedOrder>>; // ready, made before 20/11/2026 (no holder lines)
  let trial: Awaited<ReturnType<typeof seedOrder>>; // ready, a test order
  let gone: Awaited<ReturnType<typeof seedOrder>>; // collected already
  let plain: Awaited<ReturnType<typeof seedOrder>>; // ready: the management marks it with nobody named
  let other: Awaited<ReturnType<typeof seedOrder>>; // ready: stays ready through the refusals
  let receptionOrderId = '';
  let staffHolder = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    for (const [key, role] of [['admin', 'admin'], ['guard', 'guard'], ['manager', 'manager'], ['viewer', 'viewer'], ['cleaner', 'cleaner'], ['maintenance', 'maintenance']] as const) {
      const username = `pk-${key}-${tag}`;
      const u = await one<{ id: string }>(
        `insert into public.users (username, email, password_hash, full_name, role, is_active)
         values ($1, $2, 'x', $3, $4, true) returning id`,
        [username, role === 'guard' ? null : `${username}@example.test`, `בדיקה ${key}`, role],
      );
      made.users.push(u.id);
      users[key] = { id: u.id, username, email: null, full_name: `בדיקה ${key}`, role };
    }
    // The manager holds EVERY chips permission the matrix can grant.
    for (const mod of ['chips', 'chips_orders_manage', 'contacts', 'settings']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager!.id, mod]);
    }
    for (let i = 1; i <= 9; i++) {
      made.contacts[APT(i)] = (await one<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים רשום', $2) returning id`, [APT(i), SECRET.phoneLocal])).id;
    }

    main = await seedOrder([
      { apt: APT(1), role: 'owner', name: 'דנה מסירה', qty: 2 },
      { apt: APT(1), role: 'tenant', name: 'שרה מסירה', qty: 1, lease: true },
      { apt: APT(2), role: 'owner', name: 'דנה מסירה', qty: 1 },
    ]);
    await issue(APT(1), main.items[APT(1)]!, main.holders[0]!, 'דנה מסירה', [num(1)]);
    await issue(APT(1), main.items[APT(1)]!, main.holders[0]!, 'דנה מסירה', [num(2)], 'app');
    const saras = await issue(APT(1), main.items[APT(1)]!, main.holders[1]!, 'שרה מסירה', [num(3), num(4)]);
    // One of the renter's chips was disabled: it is not handed over.
    await deactivateChip(saras[1]!, { reason: 'damaged' }, actor('admin'));
    await issue(APT(2), main.items[APT(2)]!, main.holders[2]!, 'דנה מסירה', [num(5)]);
    // Somebody the staff added in the issue window — outside the paid quantity.
    staffHolder = (await one<{ id: string }>(
      `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, chips_count)
       values ($1, $2, 9, 'staff', 'other', 'מטפלת סיעודית', 0) returning id`, [main.id, main.items[APT(1)]])).id;
    await issue(APT(1), main.items[APT(1)]!, staffHolder, 'מטפלת סיעודית', [num(6)]);
    await ready(main.id);

    waiting = await seedOrder([{ apt: APT(3), role: 'owner', name: 'עדיין בהכנה', qty: 1 }]);
    await issue(APT(3), waiting.items[APT(3)]!, waiting.holders[0]!, 'עדיין בהכנה', [num(10)]);

    old = await seedOrder([{ apt: APT(4), role: 'owner', name: 'יוסי ותיק', qty: 2 }], { legacy: true });
    await issue(APT(4), old.items[APT(4)]!, null, 'יוסי ותיק', [num(11), num(12)]);
    await ready(old.id);

    trial = await seedOrder([{ apt: APT(5), role: 'owner', name: 'הזמנת ניסיון', qty: 1 }], { isTest: true });
    await issue(APT(5), trial.items[APT(5)]!, trial.holders[0]!, 'הזמנת ניסיון', [num(13)]);
    await ready(trial.id);

    gone = await seedOrder([{ apt: APT(6), role: 'owner', name: 'כבר נאסף', qty: 1 }]);
    await issue(APT(6), gone.items[APT(6)]!, gone.holders[0]!, 'כבר נאסף', [num(14)]);
    await pool.query(`update public.chip_orders set status = 'collected', ready_at = now(), collected_at = now() where id = $1`, [gone.id]);

    plain = await seedOrder([{ apt: APT(7), role: 'owner', name: 'בלי שם אוסף', qty: 1 }]);
    await issue(APT(7), plain.items[APT(7)]!, plain.holders[0]!, 'בלי שם אוסף', [num(15)]);
    await ready(plain.id);

    other = await seedOrder([{ apt: APT(8), role: 'owner', name: 'נשארת מוכנה', qty: 1 }]);
    await issue(APT(8), other.items[APT(8)]!, other.holders[0]!, 'נשארת מוכנה', [num(16)]);
    await ready(other.id);

    // An order of the reception: collected the moment it is made.
    const r = await saveReceptionWindow(
      { contact_id: made.contacts[APT(9)]!, groups: [{ resident_role: 'other', holder_name: 'שולם בקבלה', chip_type: 'physical', numbers: [num(17)] }] },
      { orderer: EMPTY_RECEPTION_ORDERER, payment: { method: 'cash', amount: 50 } },
      50,
      actor('admin'),
    );
    receptionOrderId = r.order!.id;
    made.orders.push(receptionOrderId);
  });

  afterAll(async () => {
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    const rows = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const c of rows) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    for (const id of made.orders) {
      // The reception order's Morning invoice row blocks deleting it (FK restrict) — by the order's id.
      await pool.query(`delete from public.chip_order_documents where order_id = $1 and credit_of is not null`, [id]);
      await pool.query(`delete from public.chip_order_documents where order_id = $1`, [id]);
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.users) {
      await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-handover:user:${id}`]);
      await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
      await pool.query(`delete from public.users where id = $1`, [id]);
    }
    await pool.end();
  });

  it('lists ONLY the orders that are ready — never one that is still being prepared, collected, or made at the reception', async () => {
    as('guard');
    const { status, orders } = await list();
    expect(status).toBe(200);
    expect(orders.map((o) => o.id).sort()).toEqual([main.id, old.id, trial.id, plain.id, other.id].sort());
    expect(orders.map((o) => o.id)).not.toContain(waiting.id);
    expect(orders.map((o) => o.id)).not.toContain(gone.id);
    expect(orders.map((o) => o.id)).not.toContain(receptionOrderId);
  });

  it('an order as the guard sees it: number, apartments, the people with the chips of each, the total — and the disabled chip is not there', async () => {
    as('guard');
    const o = (await list()).orders.find((x) => x.id === main.id)!;
    expect(o).toEqual({
      id: main.id,
      order_number: main.orderNumber,
      is_test: false,
      apartments: [APT(1), APT(2)],
      total: 5,
      orderer_note: null,
      guard_note: null,
      people: [
        // The app chip is counted; its "number" (an identifier of the app account) is not sent.
        { key: main.holders[0], name: 'דנה מסירה', apartment: APT(1), chips: [{ number: num(1), type: 'physical' }, { number: null, type: 'app' }] },
        { key: main.holders[1], name: 'שרה מסירה', apartment: APT(1), chips: [{ number: num(3), type: 'physical' }] },
        { key: staffHolder, name: 'מטפלת סיעודית', apartment: APT(1), chips: [{ number: num(6), type: 'physical' }] },
        { key: main.holders[2], name: 'דנה מסירה', apartment: APT(2), chips: [{ number: num(5), type: 'physical' }] },
      ],
    });
    expect(JSON.stringify(o)).not.toContain(num(4));
    expect((await list()).text, 'the number of an app chip never leaves the server').not.toContain(num(2));
  });

  it('an order made before 20/11/2026 has no holder lines: its one person is whoever ordered, and a test order says so', async () => {
    as('guard');
    const orders = (await list()).orders;
    expect(orders.find((x) => x.id === old.id)).toMatchObject({
      apartments: [APT(4)],
      total: 2,
      people: [{ key: PICKUP_ORDERER_KEY, name: 'יוסי ותיק', apartment: APT(4), chips: [{ number: num(11), type: 'physical' }, { number: num(12), type: 'physical' }] }],
    });
    expect(orders.find((x) => x.id === trial.id)!.is_test).toBe(true);
  });

  it('the answer holds NOTHING else of an order: no price, amount, payment, email, phone, address, lease or internal note', async () => {
    as('guard');
    const { orders, text } = await list();
    // The exact shape — a field added to the answer later fails here. The two
    // notes meant for the guard are part of it since 27/11/2026.
    for (const o of orders) {
      expect(Object.keys(o).sort()).toEqual(['apartments', 'guard_note', 'id', 'is_test', 'order_number', 'orderer_note', 'people', 'total']);
      for (const p of o.people) {
        expect(Object.keys(p).sort()).toEqual(['apartment', 'chips', 'key', 'name']);
        for (const c of p.chips) expect(Object.keys(c).sort()).toEqual(['number', 'type']);
      }
    }
    // …and the fixtures' own values are nowhere in the body.
    for (const secret of [
      SECRET.email, SECRET.holderEmail, SECRET.address, SECRET.street, SECRET.note, SECRET.leaseName, SECRET.leaseKey,
      SECRET.phoneLocal, PHONE, String(SECRET.unitPrice), 'pk-t-', 'pk-p-',
      // The amounts as stored: main's two lines (3 and 1 chips) and its total (4).
      (3 * SECRET.unitPrice).toFixed(2), (4 * SECRET.unitPrice).toFixed(2),
    ]) {
      expect(text, `the pickup answer must not carry ${secret}`).not.toContain(secret);
    }
    for (const key of ['price', 'total_paid', 'amount', 'payment', 'email', 'phone', 'address', 'lease', 'note', 'grow', 'tracking', 'invoice', 'refund']) {
      // The orderer's note and the guard note are the guard's (27/11/2026); no other "…note…" field.
      expect(text.toLowerCase(), `the pickup answer must not carry a "${key}" field`).not.toMatch(new RegExp(`"(?!orderer_note"|guard_note")[a-z_]*${key}[a-z_]*":`));
    }
  });

  // The three notes of an order (27/11/2026, Ronen): the guard sees the
  // orderer's note and the guard note in full — never the staff's internal one.
  it('notes — the guard sees "הערת המזמין" and "הערה לשומר" of a ready order in full; the staff\'s internal note never reaches the screen', async () => {
    await pool.query(
      `update public.chip_orders set orderer_note = $2, guard_note = $3, guard_note_by_name = 'בדיקה admin', guard_note_at = now() where id = $1`,
      [main.id, `למסור למשה ${tag}\nבשעות הערב`, `להתקשר לפני ${tag}`],
    );
    as('guard');
    const { orders, text } = await list();
    const o = orders.find((x) => x.id === main.id)!;
    expect(o.orderer_note).toBe(`למסור למשה ${tag}\nבשעות הערב`);
    expect(o.guard_note).toBe(`להתקשר לפני ${tag}`);
    expect(text).not.toContain(SECRET.note);
    // An order without notes says so plainly.
    expect(orders.find((x) => x.id === old.id)).toMatchObject({ orderer_note: null, guard_note: null });
    await pool.query(`update public.chip_orders set orderer_note = null, guard_note = null, guard_note_by_name = null, guard_note_at = null where id = $1`, [main.id]);
  });

  it('notes — "נמסר" may carry a delivery note: over 500 characters is refused (400) and nothing moves', async () => {
    as('guard');
    expect((await hand(main.id, { person: main.holders[0], delivery_note: 'א'.repeat(501) })).status).toBe(400);
    expect(await orderRow(main.id)).toMatchObject({ status: 'ready', delivery_note: null });
  });

  it('guard, admin and super admin get in; every other role is refused — also a manager who holds every chips permission; nobody signed in is 401', async () => {
    for (const key of ['guard', 'admin', 'super']) {
      as(key);
      expect((await pickupList.GET()).status, key).toBe(200);
    }
    for (const key of ['manager', 'viewer', 'cleaner', 'maintenance']) {
      as(key);
      const res = await pickupList.GET();
      expect(res.status, key).toBe(403);
      expect(await res.text()).not.toContain('orders');
      expect((await hand(other.id, { person: other.holders[0] })).status, key).toBe(403);
    }
    as(null);
    expect((await pickupList.GET()).status).toBe(401);
    expect((await hand(other.id, { person: other.holders[0] })).status).toBe(401);
    expect(await statusOf(other.id)).toBe('ready');
  });

  it('the guard is refused on EVERY other chip endpoint — the pickup screen is its whole reach into the module', async () => {
    as('guard');
    const id = main.id;
    const chipId = (await one<{ id: string }>(`select id from public.chips where chip_number = $1`, [num(1)])).id;
    const contactId = made.contacts[APT(1)]!;
    const itemId = main.items[APT(1)]!;
    const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://local${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const P = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

    const chips = await import('@/app/api/chips/route');
    const chip = await import('@/app/api/chips/[id]/route');
    const deactivate = await import('@/app/api/chips/[id]/deactivate/route');
    const reactivate = await import('@/app/api/chips/[id]/reactivate/route');
    const events = await import('@/app/api/chips/[id]/events/route');
    const kpis = await import('@/app/api/chips/kpis/route');
    const holdersOfPerson = await import('@/app/api/chips/holders/[contactId]/[role]/route');
    const leases = await import('@/app/api/chips/leases/route');
    const guardNote = await import('@/app/api/chip-orders/[id]/guard-note/route');
    const receptionCtx = await import('@/app/api/chips/reception/route');
    const contactChips = await import('@/app/api/contacts/[id]/chips/route');
    const orders = await import('@/app/api/chip-orders/route');
    const order = await import('@/app/api/chip-orders/[id]/route');
    const readyRoute = await import('@/app/api/chip-orders/[id]/ready/route');
    const reject = await import('@/app/api/chip-orders/[id]/reject/route');
    const cancel = await import('@/app/api/chip-orders/[id]/cancel/route');
    const holders = await import('@/app/api/chip-orders/[id]/holders/route');
    const item = await import('@/app/api/chip-orders/items/[itemId]/route');
    const registry = await import('@/app/api/chip-orders/items/[itemId]/registry/route');
    const testMode = await import('@/app/api/chip-orders/test-mode/route');
    const testOrders = await import('@/app/api/chip-orders/test-orders/route');
    const settings = await import('@/app/api/settings/chip-orders/route');
    const files = await import('@/app/api/files/[bucket]/[...path]/route');

    const calls: [string, () => Promise<Response>][] = [
      ['GET /api/chips', () => chips.GET(req('/api/chips'))],
      ['POST /api/chips', () => chips.POST(req('/api/chips', 'POST', { contact_id: contactId, groups: [] }))],
      ['GET /api/chips/:id', () => chip.GET(req(`/api/chips/${chipId}`), P({ id: chipId }))],
      ['PATCH /api/chips/:id', () => chip.PATCH(req(`/api/chips/${chipId}`, 'PATCH', { notes: 'x' }), P({ id: chipId }))],
      ['POST /api/chips/:id/deactivate', () => deactivate.POST(req(`/api/chips/${chipId}/deactivate`, 'POST', { reason: 'lost' }), P({ id: chipId }))],
      ['POST /api/chips/:id/reactivate', () => reactivate.POST(req(`/api/chips/${chipId}/reactivate`, 'POST', {}), P({ id: chipId }))],
      ['GET /api/chips/:id/events', () => events.GET(req(`/api/chips/${chipId}/events`), P({ id: chipId }))],
      ['GET /api/chips/kpis', () => kpis.GET()],
      ['GET /api/chips/holders/:contact/:role', () => holdersOfPerson.GET(req(`/api/chips/holders/${contactId}/owner`), P({ contactId, role: 'owner' }))],
      ['POST /api/chips/leases', () => leases.POST(req('/api/chips/leases', 'POST', {}))],
      ['GET /api/chips/reception', () => receptionCtx.GET(req(`/api/chips/reception?contact_id=${contactId}`))],
      ['GET /api/contacts/:id/chips', () => contactChips.GET(req(`/api/contacts/${contactId}/chips`), P({ id: contactId }))],
      ['GET /api/chip-orders', () => orders.GET()],
      ['DELETE /api/chip-orders/:id', () => order.DELETE(req(`/api/chip-orders/${id}`, 'DELETE'), P({ id }))],
      ['POST /api/chip-orders/:id/ready', () => readyRoute.POST(req(`/api/chip-orders/${id}/ready`, 'POST'), P({ id }))],
      // "הערה לשומר" (27/11/2026): never the guard's to write.
      ['POST /api/chip-orders/:id/guard-note', () => guardNote.POST(req(`/api/chip-orders/${id}/guard-note`, 'POST', { guard_note: 'x' }), P({ id }))],
      ['POST /api/chip-orders/:id/collected', () => collect(id, { person: main.holders[0] })],
      ['POST /api/chip-orders/:id/reject', () => reject.POST(req(`/api/chip-orders/${id}/reject`, 'POST', { reason: 'ניסיון' }), P({ id }))],
      ['POST /api/chip-orders/:id/cancel', () => cancel.POST(req(`/api/chip-orders/${receptionOrderId}/cancel`, 'POST', { reason: 'ניסיון' }), P({ id: receptionOrderId }))],
      ['POST /api/chip-orders/:id/holders', () => holders.POST(req(`/api/chip-orders/${id}/holders`, 'POST', { holders: [] }), P({ id }))],
      ['GET /api/chip-orders/items/:item', () => item.GET(req(`/api/chip-orders/items/${itemId}`), P({ itemId }))],
      ['POST /api/chip-orders/items/:item/registry', () => registry.POST(req(`/api/chip-orders/items/${itemId}/registry`, 'POST', { name: 'x' }), P({ itemId }))],
      ['GET /api/chip-orders/test-mode', () => testMode.GET()],
      ['POST /api/chip-orders/test-mode', () => testMode.POST(req('/api/chip-orders/test-mode', 'POST', { action: 'enable' }))],
      ['DELETE /api/chip-orders/test-orders', () => testOrders.DELETE()],
      ['GET /api/settings/chip-orders', () => settings.GET()],
      ['PUT /api/settings/chip-orders', () => settings.PUT(req('/api/settings/chip-orders', 'PUT', { unitPrice: 1 }))],
      // The lease of the renter of the very order the guard may hand over.
      ['GET /api/files/chip-order-leases/:key', () => files.GET(req(`/api/files/chip-order-leases/${SECRET.leaseKey}`), { params: Promise.resolve({ bucket: 'chip-order-leases', path: [SECRET.leaseKey] }) })],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      expect(res.status, name).toBe(403);
      const text = await res.text();
      expect(text, name).not.toContain(SECRET.email);
      expect(text, name).not.toContain(num(1));
    }
    // Nothing moved under the refusals.
    expect(await statusOf(main.id)).toBe('ready');
    expect(await statusOf(receptionOrderId)).toBe('collected');
    expect((await one<{ status: string }>(`select status from public.chips where id = $1`, [chipId])).status).toBe('active');
  }, 60_000);

  it('POST /api/chips no longer takes an order line: chips of an order are issued from the order\'s own window, where a chip beyond the paid quantity must be settled', async () => {
    as('admin');
    const chips = await import('@/app/api/chips/route');
    const res = await chips.POST(new NextRequest('http://local/api/chips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contact_id: made.contacts[APT(3)],
        groups: [{ resident_role: 'other', holder_name: 'עוקף תשלום', chip_type: 'physical', numbers: [num(30)], order_item_id: waiting.items[APT(3)] }],
        payment: { method: 'none', amount: 0 },
      }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/מחלון ההזמנה/);
    expect(Number((await one<{ n: string }>(`select count(*) as n from public.chips where chip_number = $1`, [num(30)])).n)).toBe(0);
  });

  it('"נמסר" needs a person, and the person must be one of THAT order — a refusal changes nothing', async () => {
    as('guard');
    expect((await hand(other.id, {})).status).toBe(400);
    expect((await hand(other.id, { person: null })).status).toBe(400);
    expect((await hand(other.id, { person: 'נשארת מוכנה' })).status).toBe(400);
    // A person of ANOTHER order.
    const foreign = await hand(other.id, { person: main.holders[0] });
    expect(foreign.status).toBe(400);
    expect((await foreign.json() as { error: string }).error).toMatch(/אינו חלק מההזמנה/);
    // The orderer is a person only of an order that has no holder lines.
    expect((await hand(other.id, { person: PICKUP_ORDERER_KEY })).status).toBe(400);
    // A random id.
    expect((await hand(other.id, { person: randomUUID() })).status).toBe(400);
    expect(await orderRow(other.id)).toMatchObject({ status: 'ready', collected_at: null, collected_by_name: null, handed_over_via: null });
    expect(await trail(other.id)).toEqual([]);
  });

  it('"נמסר" moves ONLY an order that is ready: one still being prepared, one collected already and a reception order are refused', async () => {
    as('guard');
    const notReady = await hand(waiting.id, { person: waiting.holders[0] });
    expect(notReady.status).toBe(409);
    expect((await notReady.json() as { error: string }).error).toMatch(/מוכנה לאיסוף/);
    expect(await orderRow(waiting.id)).toMatchObject({ status: 'paid', handed_over_via: null });

    expect((await hand(gone.id, { person: gone.holders[0] })).status).toBe(409);
    expect((await hand(receptionOrderId, { person: PICKUP_ORDERER_KEY })).status).toBe(409);
    expect(await statusOf(receptionOrderId)).toBe('collected');

    expect((await hand(randomUUID(), { person: PICKUP_ORDERER_KEY })).status).toBe(404);
    expect((await hand('not-an-id', { person: PICKUP_ORDERER_KEY })).status).toBe(404);
    for (const id of [waiting.id, gone.id]) expect(await trail(id)).toEqual([]);
  });

  it('"נמסר": the order is collected — who handed over, when, who collected and the delivery note are on the order and in the audit log', async () => {
    as('guard');
    // "הערת מסירה" (27/11/2026): trimmed, line breaks kept, with the guard and the time.
    const res = await hand(main.id, { person: main.holders[1], delivery_note: '  נמסר לבת של שרה\r\nהציגה ת״ז  ' });
    expect(res.status).toBe(200);
    // The answer carries nothing of the order.
    expect(await res.json()).toEqual({ ok: true });

    const row = await orderRow(main.id);
    expect(row).toMatchObject({
      status: 'collected',
      collected_by_name: 'שרה מסירה',
      collected_holder_id: main.holders[1],
      handed_over_by: users.guard!.id,
      handed_over_by_name: 'בדיקה guard',
      handed_over_via: 'pickup',
      delivery_note: 'נמסר לבת של שרה\nהציגה ת״ז',
      delivery_note_by: users.guard!.id,
      delivery_note_by_name: 'בדיקה guard',
    });
    expect(row.collected_at).not.toBeNull();
    expect(row.delivery_note_at).not.toBeNull();
    expect(await trail(main.id)).toEqual([{
      action: 'collected',
      actor_user_id: users.guard!.id,
      metadata: {
        via: 'pickup', order_number: main.orderNumber, collector: 'holder', collector_holder_id: main.holders[1], collector_name: 'שרה מסירה',
        delivery_note: 'נמסר לבת של שרה\nהציגה ת״ז',
      },
    }]);
    // Like the management's "נאסף", nobody is notified.
    expect(Number((await one<{ n: string }>(`select count(*) as n from public.chip_order_notifications where order_id = $1`, [main.id])).n)).toBe(0);
    // It left the list, and a second "נמסר" is refused.
    expect((await list()).orders.map((o) => o.id)).not.toContain(main.id);
    expect((await hand(main.id, { person: main.holders[0] })).status).toBe(409);
    expect((await trail(main.id))).toHaveLength(1);
  });

  it('an order with no holder lines is collected by its orderer — the name is the order\'s own', async () => {
    as('admin');
    expect((await hand(old.id, { person: PICKUP_ORDERER_KEY })).status).toBe(200);
    expect(await orderRow(old.id)).toMatchObject({
      status: 'collected', collected_by_name: 'יוסי ותיק', collected_holder_id: null,
      handed_over_by: users.admin!.id, handed_over_via: 'pickup',
    });
    expect((await trail(old.id))[0]!.metadata).toMatchObject({ via: 'pickup', collector: 'orderer', collector_holder_id: null, collector_name: 'יוסי ותיק' });
  });

  it('the management\'s "נאסף" keeps working with no body — nobody is named — and records who marked it', async () => {
    as('admin');
    expect((await collect(plain.id)).status).toBe(200);
    expect(await orderRow(plain.id)).toMatchObject({
      status: 'collected', collected_by_name: null, collected_holder_id: null,
      handed_over_by: users.admin!.id, handed_over_by_name: 'בדיקה admin', handed_over_via: 'management',
    });
    expect((await trail(plain.id))[0]).toMatchObject({ action: 'collected', actor_user_id: users.admin!.id, metadata: { via: 'management', collector: null, collector_name: null, delivery_note: null } });
    expect(await orderRow(plain.id)).toMatchObject({ delivery_note: null, delivery_note_by_name: null, delivery_note_at: null });
  });

  it('the management MAY name who collected — and only a person of the order', async () => {
    as('super');
    expect((await collect(trial.id, { person: main.holders[0] })).status).toBe(400);
    expect(await statusOf(trial.id)).toBe('ready');
    expect((await collect(trial.id, { person: 'שם שהוקלד' })).status).toBe(400);
    expect((await collect(trial.id, { person: trial.holders[0], delivery_note: 'נמסר במשרד' })).status).toBe(200);
    expect(await orderRow(trial.id)).toMatchObject({
      status: 'collected', collected_by_name: 'הזמנת ניסיון', collected_holder_id: trial.holders[0], handed_over_via: 'management',
      // "הערת מסירה" of the staff's "נאסף" (27/11/2026).
      delivery_note: 'נמסר במשרד', delivery_note_by: users.super!.id,
    });
    // A manager who holds chips_orders_manage through the matrix may mark it too (the route's own permission)…
    as('manager');
    expect((await collect(other.id)).status).toBe(200);
    expect(await orderRow(other.id)).toMatchObject({ status: 'collected', handed_over_by: users.manager!.id, handed_over_via: 'management' });
    // …and the guard never through this route.
    as('guard');
    expect((await collect(waiting.id)).status).toBe(403);
  });

  it('an order whose chips were all disabled has nothing to hand over: "נמסר" is refused on the pickup screen — the management can still close it', async () => {
    made.contacts[APT(10)] = (await one<{ id: string }>(`insert into public.contacts (apartment_number, owner_name) values ($1, 'בעלים רשום') returning id`, [APT(10)])).id;
    const empty = await seedOrder([{ apt: APT(10), role: 'owner', name: 'בלי צ׳יפים פעילים', qty: 1 }]);
    const [chipId] = await issue(APT(10), empty.items[APT(10)]!, empty.holders[0]!, 'בלי צ׳יפים פעילים', [num(20)]);
    await ready(empty.id);
    await deactivateChip(chipId!, { reason: 'lost' }, actor('admin'));

    as('guard');
    // The guard sees the order with nothing in it…
    expect((await list()).orders.find((o) => o.id === empty.id)).toMatchObject({ total: 0, people: [{ name: 'בלי צ׳יפים פעילים', chips: [] }] });
    // …and cannot close it.
    const res = await hand(empty.id, { person: empty.holders[0] });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/אין צ׳יפים פעילים/);
    expect(await orderRow(empty.id)).toMatchObject({ status: 'ready', handed_over_via: null, collected_by_name: null });
    expect(await trail(empty.id)).toEqual([]);
    // What happened to its chips is the management's to sort out: its own "נאסף" is unchanged.
    as('admin');
    expect((await collect(empty.id)).status).toBe(200);
    expect(await orderRow(empty.id)).toMatchObject({ status: 'collected', handed_over_via: 'management' });
  });

  it('notes — "הערה לשומר" through its own route (the reception window): written by staff, audited, only while the order is open; too long → 400', async () => {
    const guardNoteRoute = await import('@/app/api/chip-orders/[id]/guard-note/route');
    const write = (orderId: string, body: unknown) => guardNoteRoute.POST(
      new Request(`http://local/api/chip-orders/${orderId}/guard-note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: orderId }) },
    );
    as('admin');
    const ok = await write(waiting.id, { guard_note: '  לא למסור בלי ת״ז  ' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, changed: true, guard_note: 'לא למסור בלי ת״ז' });
    const row = await one<{ guard_note: string | null; guard_note_by: string | null; guard_note_by_name: string | null }>(
      `select guard_note, guard_note_by, guard_note_by_name from public.chip_orders where id = $1`, [waiting.id]);
    expect(row).toEqual({ guard_note: 'לא למסור בלי ת״ז', guard_note_by: users.admin!.id, guard_note_by_name: 'בדיקה admin' });
    expect((await trail(waiting.id)).filter((t) => t.action === 'guard_note_set')).toEqual([
      { action: 'guard_note_set', actor_user_id: users.admin!.id, metadata: { order_number: waiting.orderNumber, before: null, after: 'לא למסור בלי ת״ז' } },
    ]);
    expect((await write(waiting.id, { guard_note: 'א'.repeat(501) })).status).toBe(400);
    // A body that does not name the note changes nothing (security review, 27/11/2026).
    expect((await write(waiting.id, {})).status).toBe(400);
    expect((await one<{ guard_note: string | null }>(`select guard_note from public.chip_orders where id = $1`, [waiting.id])).guard_note).toBe('לא למסור בלי ת״ז');
    // Cleared with an empty note.
    expect((await write(waiting.id, { guard_note: '' })).status).toBe(200);
    expect((await one<{ guard_note: string | null }>(`select guard_note from public.chip_orders where id = $1`, [waiting.id])).guard_note).toBeNull();
    // Handed over already: the note is history.
    expect((await write(plain.id, { guard_note: 'מאוחר מדי' })).status).toBe(409);
    as('guard');
    expect((await write(waiting.id, { guard_note: 'שומר כותב' })).status).toBe(403);
  });

  it('a hand-over cannot be undone, so one user is held to a ceiling of them: past it "נמסר" answers 429 and the order stays ready', async () => {
    made.contacts[APT(11)] = (await one<{ id: string }>(`insert into public.contacts (apartment_number, owner_name) values ($1, 'בעלים רשום') returning id`, [APT(11)])).id;
    const limited = await seedOrder([{ apt: APT(11), role: 'owner', name: 'מעבר לתקרה', qty: 1 }]);
    await issue(APT(11), limited.items[APT(11)]!, limited.holders[0]!, 'מעבר לתקרה', [num(21)]);
    await ready(limited.id);
    const bucket = `chip-handover:user:${users.guard!.id}`;
    // Thirty hand-overs in the last ten minutes, as the limiter records them.
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [bucket]);
    await pool.query(`insert into public.auth_rate_limits (bucket) select $1 from generate_series(1, 30)`, [bucket]);

    as('guard');
    const res = await hand(limited.id, { person: limited.holders[0] });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('600');
    expect(await orderRow(limited.id)).toMatchObject({ status: 'ready', handed_over_via: null });
    expect(await trail(limited.id)).toEqual([]);
    // Another user's count is their own.
    as('admin');
    expect((await hand(limited.id, { person: limited.holders[0] })).status).toBe(200);
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [bucket]);
  });
});

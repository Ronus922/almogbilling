import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

// Extra chips added to a WEB order (25/11/2026) on the DB, against a throwaway
// database (WA_TEST_DATABASE_URL), never prod. An apartment line paid online
// for a quantity; a new number beyond it is an extra chip, and the save of the
// order's window must say how the extras are settled — with the rules of
// issuing at the reception:
//   · no payment named → the save is refused, nothing is stored;
//   · cash or a transfer → a RECEPTION order for those chips only (paid,
//     collected, nobody notified, its payment on record and audited), linked
//     back to the web order and to the person the chips were added for. The
//     amount is the server's; a save whose amount differs is refused;
//   · no charge → no order; the extras stay on the web order's own line;
//   · the web order — its lines, its quantity, its total — never changes;
//   · a number that only fills the place of a disabled chip is not extra;
//   · the pickup screen and the order's window list the paid extras under the
//     person; cancelling the reception order disables exactly them.
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

const { requireSeededAdmin } = await import('./db-fixtures');
const win = await import('@/lib/db/chipOrderWindow');
const orders = await import('@/lib/db/chipOrders');
const chipsDb = await import('@/lib/db/chips');
const { ReceptionError } = await import('@/lib/db/chipReception');
const { listReadyPickupOrders } = await import('@/lib/db/chipPickup');

const tag = String(Date.now()).slice(-6);
const APT = (n: number) => `998${tag}${n}`;
const num = (n: number) => `E${tag}${n}`;
const PRICE = 50;
const made = { contacts: {} as Record<string, string>, orders: [] as string[] };
let admin: { id: string; name: string };

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await pool.query<T>(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

interface Row { apt: string; role: 'owner' | 'tenant'; name: string; phone: string; qty: number }

async function seedOrder(rows: Row[]) {
  const n = made.orders.length;
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  const o = await one<{ id: string; order_number: number }>(
    `insert into public.chip_orders
       (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at,
        grow_process_id, grow_transaction_id, address_street, address_city, address_zip)
     values ($1, $2, 'web-extra@example.test', 'רחוב התוספת 3, חיפה 3300000', 'owner', 'paid', $3, $4, now(), now() + interval '3 days',
             $5, $6, 'רחוב התוספת 3', 'חיפה', '3300000')
     returning id, order_number`,
    [rows[0]!.name, rows[0]!.phone, qty * PRICE, randomBytes(32).toString('base64url'), `ex-p-${tag}-${n}`, `ex-t-${tag}-${n}`],
  );
  made.orders.push(o.id);
  const items: Record<string, string> = {};
  for (const apt of [...new Set(rows.map((r) => r.apt))]) {
    const q = rows.filter((r) => r.apt === apt).reduce((s, r) => s + r.qty, 0);
    items[apt] = (await one<{ id: string }>(
      `insert into public.chip_order_items
         (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, $4, $5, $4, $5, $6, 'matched') returning id`,
      [o.id, made.contacts[apt], apt, q, PRICE, q * PRICE],
    )).id;
  }
  const holders: string[] = [];
  for (const [position, r] of rows.entries()) {
    holders.push((await one<{ id: string }>(
      `insert into public.chip_order_holders (order_id, item_id, position, source, role, full_name, phone, chips_count)
       values ($1, $2, $3, 'order', $4, $5, $6, $7) returning id`,
      [o.id, items[r.apt], position, r.role, r.name, r.phone, r.qty],
    )).id);
  }
  return { id: o.id, orderNumber: o.order_number, items, holders, rows };
}

/** One block of a save of the order's window. */
const block = (o: Awaited<ReturnType<typeof seedOrder>>, index: number, numbers: string[], type: 'physical' | 'app' = 'physical') => ({
  id: o.holders[index]!, item_id: o.items[o.rows[index]!.apt]!, role: o.rows[index]!.role, full_name: o.rows[index]!.name,
  phone: o.rows[index]!.phone, email: null, new_chips: numbers.map((number) => ({ number, chip_type: type })),
});

const webOrder = (id: string) => one<{ status: string; total: number; chips: number; lines: number; holders: number }>(
  `select o.status, o.total::float8 as total,
          (select coalesce(sum(i.chips_count), 0)::int from public.chip_order_items i where i.order_id = o.id) as chips,
          (select count(*)::int from public.chip_order_items i where i.order_id = o.id) as lines,
          (select count(*)::int from public.chip_order_holders h where h.order_id = o.id) as holders
     from public.chip_orders o where o.id = $1`,
  [id],
);
const extrasOf = async (webId: string) => (await pool.query<{
  id: string; order_number: number; source: string; status: string; total: number; is_test: boolean; payment_method: string;
  payment_recorded_by: string; full_name: string; phone_e164: string; email: string; address: string;
}>(
  `select id, order_number, source, status, total::float8 as total, is_test, payment_method, payment_recorded_by, full_name, phone_e164, email, address
     from public.chip_orders where extra_of_order_id = $1 order by created_at`,
  [webId],
)).rows;
const chipOf = (number: string) => one<{ id: string; status: string; order_item_id: string | null; order_holder_id: string | null; holder_name: string | null }>(
  `select id, status, order_item_id, order_holder_id, holder_name from public.chips where chip_number = $1`, [number]);
const chipsNumbered = (numbers: string[]) => count(`select count(*) as n from public.chips where chip_number = any($1::text[])`, [numbers]);

d('extra chips added to a web order, on the DB', () => {
  let order: Awaited<ReturnType<typeof seedOrder>>; // apartment 1: an owner (2) and a renter (1) → the line paid for 3
  let free: Awaited<ReturnType<typeof seedOrder>>; // apartment 2: 1 chip, extras with no charge
  let two: Awaited<ReturnType<typeof seedOrder>>; // apartments 3 + 4, 1 chip each

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    for (let i = 1; i <= 6; i++) {
      made.contacts[APT(i)] = (await one<{ id: string }>(`insert into public.contacts (apartment_number, owner_name) values ($1, 'בעלים רשום') returning id`, [APT(i)])).id;
    }
    order = await seedOrder([
      { apt: APT(1), role: 'owner', name: 'דנה תוספת', phone: '+972539311001', qty: 2 },
      { apt: APT(1), role: 'tenant', name: 'שרה תוספת', phone: '+972539311002', qty: 1 },
    ]);
    free = await seedOrder([{ apt: APT(2), role: 'owner', name: 'רון ללא חיוב', phone: '+972539311003', qty: 1 }]);
    two = await seedOrder([
      { apt: APT(3), role: 'owner', name: 'גיל שתי דירות', phone: '+972539311004', qty: 1 },
      { apt: APT(4), role: 'owner', name: 'גיל שתי דירות', phone: '+972539311004', qty: 1 },
    ]);
  });

  afterAll(async () => {
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    const rows = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const c of rows) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    // The reception orders the saves made, then the web orders themselves.
    const all = (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const o of all) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [o.id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [o.id]);
    }
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('numbers inside the quantity the line paid for need no payment — as before', async () => {
    const res = await win.saveChipOrderWindow(order.id, { holders: [block(order, 0, [num(1)])] }, admin, PRICE);
    expect(res).toEqual({ issued: 1, updated: 0, extra: null });
    expect(await chipOf(num(1))).toMatchObject({ order_item_id: order.items[APT(1)], order_holder_id: order.holders[0] });
  });

  it('a number beyond the paid quantity with no payment named is refused — and NOTHING of the save is stored', async () => {
    // The line paid for 3 and holds 1: two fit, the third is extra.
    const err = await win.saveChipOrderWindow(order.id, {
      holders: [block(order, 0, [num(2)]), block(order, 1, [num(3), num(4)])],
      note: 'הערה שלא תישמר',
    }, admin, PRICE).catch((e) => e);
    expect(err).toBeInstanceOf(ReceptionError);
    expect(err).toMatchObject({ code: 'payment_required', expectedAmount: PRICE });
    expect(await chipsNumbered([num(2), num(3), num(4)])).toBe(0);
    expect(await extrasOf(order.id)).toEqual([]);
    expect((await one<{ internal_note: string | null }>(`select internal_note from public.chip_orders where id = $1`, [order.id])).internal_note).toBeNull();
  });

  it('"מזומן או העברה" with a sum that is not extras × the price is refused with the right sum, and nothing is stored', async () => {
    for (const amount of [0, PRICE * 2, PRICE - 0.01]) {
      const err = await win.saveChipOrderWindow(order.id, {
        holders: [block(order, 0, [num(2)]), block(order, 1, [num(3), num(4)])],
        extraPayment: { method: 'cash_transfer', amount },
      }, admin, PRICE).catch((e) => e);
      expect(err, String(amount)).toMatchObject({ code: 'amount_mismatch', expectedAmount: PRICE });
    }
    expect(await chipsNumbered([num(2), num(3), num(4)])).toBe(0);
    expect(await extrasOf(order.id)).toEqual([]);
  });

  it('"מזומן או העברה": a reception order for the extra chip ONLY — paid, collected, on record, audited, nobody notified — and the web order does not change', async () => {
    const before = await webOrder(order.id);
    const res = await win.saveChipOrderWindow(order.id, {
      holders: [block(order, 0, [num(2)]), block(order, 1, [num(3), num(4)])],
      extraPayment: { method: 'cash_transfer', amount: PRICE },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 3, extra: { chips: 1, method: 'cash_transfer', order: { total: PRICE } } });

    // The web order: the same lines, quantity, people and total.
    expect(await webOrder(order.id)).toEqual(before);
    // Its line holds exactly what it paid for — the first numbers of the save.
    expect(await chipOf(num(2))).toMatchObject({ order_item_id: order.items[APT(1)], order_holder_id: order.holders[0] });
    expect(await chipOf(num(3))).toMatchObject({ order_item_id: order.items[APT(1)], order_holder_id: order.holders[1] });
    expect(await count(`select count(*) as n from public.chips where order_item_id = $1 and status = 'active'`, [order.items[APT(1)]])).toBe(3);

    // The reception order.
    const extras = await extrasOf(order.id);
    expect(extras).toHaveLength(1);
    const x = extras[0]!;
    made.orders.push(x.id);
    expect(x).toMatchObject({
      source: 'reception', status: 'collected', total: PRICE, is_test: false, payment_method: 'cash_transfer', payment_recorded_by: admin.id,
      // Whoever placed the web order is who the chips were added for.
      full_name: 'דנה תוספת', phone_e164: '+972539311001', email: 'web-extra@example.test', address: 'רחוב התוספת 3, חיפה 3300000',
    });
    expect(x.order_number).toBe(res!.extra!.order!.order_number);
    const line = await one<{ id: string; contact_id: string; chips_count: number; line_total: number; unit_price: number }>(
      `select id, contact_id, chips_count, line_total::float8 as line_total, unit_price::float8 as unit_price from public.chip_order_items where order_id = $1`, [x.id]);
    expect(line).toMatchObject({ contact_id: made.contacts[APT(1)], chips_count: 1, line_total: PRICE, unit_price: PRICE });
    const person = await one<{ id: string; source: string; full_name: string; role: string; chips_count: number; extra_of_holder_id: string }>(
      `select id, source, full_name, role, chips_count, extra_of_holder_id from public.chip_order_holders where order_id = $1`, [x.id]);
    expect(person).toMatchObject({ source: 'reception', full_name: 'שרה תוספת', role: 'tenant', chips_count: 1, extra_of_holder_id: order.holders[1] });
    // The extra chip belongs to the reception order's line and person.
    expect(await chipOf(num(4))).toMatchObject({ status: 'active', order_item_id: line.id, order_holder_id: person.id, holder_name: 'שרה תוספת' });

    expect(await count(`select count(*) as n from public.chip_order_notifications where order_id = any($1::uuid[])`, [[x.id, order.id]])).toBe(0);
    const trail = (await pool.query<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `select action, actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 order by action`, [x.id])).rows;
    expect(trail.map((t) => t.action)).toEqual(['created', 'payment_recorded']);
    expect(trail[1]).toMatchObject({
      actor_user_id: admin.id,
      metadata: { source: 'web_order_extra', extra_of_order: order.orderNumber, order_number: x.order_number, chips: 1, unit_price: PRICE, method: 'cash_transfer', amount: PRICE },
    });
  });

  it('the order can be marked ready on what it paid for; its window and the pickup screen list the paid extra under the person', async () => {
    expect(await orders.markChipOrderReady(order.id)).toBe(true);

    const w = (await win.getChipOrderWindow(order.items[APT(1)]!))!;
    expect(w.items[0]).toMatchObject({ chips_count: 3, chips_linked: 3 });
    const sara = w.holders.find((h) => h.id === order.holders[1])!;
    expect(sara.chips.map((c) => c.chip_number)).toEqual([num(3)]);
    expect(sara.extras.map((c) => c.chip_number)).toEqual([num(4)]);
    // It is not shown a second time as an "earlier" chip of the same person.
    expect(w.holders.flatMap((h) => h.existing.map((c) => c.chip_number))).not.toContain(num(4));
    expect(w.extra_orders).toEqual([{ order_number: (await extrasOf(order.id))[0]!.order_number, status: 'collected', total: PRICE, chips_count: 1 }]);
    expect(w.order.extra_of_order_number).toBeNull();

    // The reception order's own window says whose extras they are.
    const x = (await extrasOf(order.id))[0]!;
    const xItem = (await one<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [x.id])).id;
    expect((await win.getChipOrderWindow(xItem))!.order).toMatchObject({ source: 'reception', extra_of_order_number: order.orderNumber });
    // …and its row in the Orders tab carries the web order's number.
    const row = (await orders.listOpenChipOrderRows()).find((r) => r.order_id === x.id)!;
    expect(row).toMatchObject({ source: 'reception', status: 'collected', extra_of_order_number: order.orderNumber, chips_count: 1, line_total: PRICE });

    const pickup = (await listReadyPickupOrders()).find((o) => o.id === order.id)!;
    expect(pickup.total).toBe(4);
    expect(pickup.people.map((p) => [p.name, p.chips.map((c) => c.number)])).toEqual([
      ['דנה תוספת', [num(1), num(2)]],
      ['שרה תוספת', [num(3), num(4)]],
    ]);
  });

  it('cancelling the reception order disables exactly the extra chip — the web order and its chips are untouched, and the pickup screen drops it', async () => {
    const x = (await extrasOf(order.id))[0]!;
    expect(await orders.cancelReceptionOrder(x.id, 'התוספת בוטלה', admin)).toMatchObject({ chips_disabled: 1 });
    expect((await chipOf(num(4))).status).toBe('inactive');
    for (const n of [num(1), num(2), num(3)]) expect((await chipOf(n)).status).toBe('active');
    expect((await webOrder(order.id)).status).toBe('ready');
    const pickup = (await listReadyPickupOrders()).find((o) => o.id === order.id)!;
    expect(pickup.total).toBe(3);
    expect(JSON.stringify(pickup)).not.toContain(num(4));
    expect((await win.getChipOrderWindow(order.items[APT(1)]!))!.extra_orders[0]).toMatchObject({ status: 'rejected' });
  });

  it('"ללא חיוב": no order — the extras stay on the web order\'s own line, and the save is audited', async () => {
    const before = await webOrder(free.id);
    const res = await win.saveChipOrderWindow(free.id, {
      holders: [block(free, 0, [num(10), num(11), num(12)])],
      extraPayment: { method: 'none', amount: 0 },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 3, extra: { chips: 2, method: 'none', order: null } });
    expect(await extrasOf(free.id)).toEqual([]);
    expect(await webOrder(free.id)).toEqual(before);
    for (const n of [num(10), num(11), num(12)]) {
      expect(await chipOf(n)).toMatchObject({ order_item_id: free.items[APT(2)], order_holder_id: free.holders[0] });
    }
    const trail = (await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `select action, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [free.id])).rows;
    expect(trail).toEqual([{
      action: 'extra_chips_no_charge',
      metadata: { source: 'web_order_extra', extra_of_order: free.orderNumber, order_number: free.orderNumber, chips: 2, unit_price: PRICE, method: 'none', amount: 0 },
    }]);
  });

  it('a number that fills the place of a DISABLED chip is not extra: only active chips take room', async () => {
    // The line paid for 1 and holds 3 active (1 + 2 free extras). Disable all three…
    for (const n of [num(10), num(11), num(12)]) await chipsDb.deactivateChip((await chipOf(n)).id, { reason: 'damaged' }, admin);
    // …and one new number fits inside the paid quantity again: no payment needed.
    const res = await win.saveChipOrderWindow(free.id, { holders: [block(free, 0, [num(13)])] }, admin, PRICE);
    expect(res).toEqual({ issued: 1, updated: 0, extra: null });
    // The next one is extra again.
    await expect(win.saveChipOrderWindow(free.id, { holders: [block(free, 0, [num(14)])] }, admin, PRICE)).rejects.toMatchObject({ code: 'payment_required' });
  });

  it('extras in two apartments of one order → ONE reception order with a line per apartment; each apartment counts for itself', async () => {
    // Apartment 3 gets 1 (inside) + 1 extra; apartment 4 gets 3: 1 inside + 2 extra → 3 extras in all.
    const res = await win.saveChipOrderWindow(two.id, {
      holders: [block(two, 0, [num(20), num(21)]), block(two, 1, [num(22), num(23)]), block(two, 1, [num(24)], 'app')],
      extraPayment: { method: 'cash_transfer', amount: 3 * PRICE },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 5, extra: { chips: 3, method: 'cash_transfer', order: { total: 3 * PRICE } } });
    const extras = await extrasOf(two.id);
    expect(extras).toHaveLength(1);
    const lines = (await pool.query<{ apartment_number: string; chips_count: number; line_total: number }>(
      `select apartment_number, chips_count, line_total::float8 as line_total from public.chip_order_items where order_id = $1 order by apartment_number`, [extras[0]!.id])).rows;
    expect(lines).toEqual([
      { apartment_number: APT(3), chips_count: 1, line_total: PRICE },
      { apartment_number: APT(4), chips_count: 2, line_total: 2 * PRICE },
    ]);
    expect(extras[0]!.total).toBe(3 * PRICE);
    // Inside the paid quantity: the first number of each apartment.
    expect((await chipOf(num(20))).order_item_id).toBe(two.items[APT(3)]);
    expect((await chipOf(num(22))).order_item_id).toBe(two.items[APT(4)]);
    for (const n of [num(21), num(23), num(24)]) {
      const c = await chipOf(n);
      expect(c.order_item_id).not.toBe(two.items[APT(3)]);
      expect(c.order_item_id).not.toBe(two.items[APT(4)]);
    }
    expect(await webOrder(two.id)).toMatchObject({ total: 2 * PRICE, chips: 2, lines: 2, holders: 2 });
  });

  it('a taken number refuses the whole save: no chip, and no reception order left behind', async () => {
    const ordersBefore = (await extrasOf(two.id)).length;
    const err = await win.saveChipOrderWindow(two.id, {
      holders: [block(two, 0, [num(30), num(1)])], // num(1) is active on another apartment
      extraPayment: { method: 'cash_transfer', amount: 2 * PRICE },
    }, admin, PRICE).catch((e) => e);
    expect(err).toBeInstanceOf(win.WindowChipConflictError);
    expect(await chipsNumbered([num(30)])).toBe(0);
    expect(await extrasOf(two.id)).toHaveLength(ordersBefore);
  });

  // ── What the review of 25/11/2026 found ──────────────────────────────────

  let split: Awaited<ReturnType<typeof seedOrder>>; // apartment 5: Dana ordered 2 (first block), Sara 1 (second)

  it('a sum confirmed while NOTHING is extra is refused — never saved with the payment dropped', async () => {
    split = await seedOrder([
      { apt: APT(5), role: 'owner', name: 'דנה פיצול', phone: '+972539311005', qty: 2 },
      { apt: APT(5), role: 'tenant', name: 'שרה פיצול', phone: '+972539311006', qty: 1 },
    ]);
    // The window believed one chip was extra (it had loaded an older state) and confirmed its price.
    const err = await win.saveChipOrderWindow(split.id, {
      holders: [block(split, 0, [num(40)])],
      extraPayment: { method: 'cash_transfer', amount: PRICE },
    }, admin, PRICE).catch((e) => e);
    expect(err).toBeInstanceOf(ReceptionError);
    expect(err).toMatchObject({ code: 'amount_mismatch', expectedAmount: 0 });
    expect(await chipsNumbered([num(40)])).toBe(0);
    expect(await extrasOf(split.id)).toEqual([]);
  });

  it('WHOSE chip is extra: the person who got more than they ordered — never a neighbour who only got what they paid for', async () => {
    // One save: Dana (ordered 2) gets three numbers, Sara (ordered 1) gets one. The line paid for 3.
    const res = await win.saveChipOrderWindow(split.id, {
      holders: [block(split, 0, [num(40), num(41), num(42)]), block(split, 1, [num(43)])],
      extraPayment: { method: 'cash_transfer', amount: PRICE },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 4, extra: { chips: 1, method: 'cash_transfer', order: { total: PRICE } } });
    const webLine = split.items[APT(5)];
    // Dana's first two and Sara's one are the order's own chips…
    expect(await chipOf(num(40))).toMatchObject({ order_item_id: webLine, order_holder_id: split.holders[0] });
    expect(await chipOf(num(41))).toMatchObject({ order_item_id: webLine, order_holder_id: split.holders[0] });
    expect(await chipOf(num(43))).toMatchObject({ order_item_id: webLine, order_holder_id: split.holders[1], holder_name: 'שרה פיצול' });
    // …and the extra one is Dana's third: on the reception order, under Dana.
    const x = (await extrasOf(split.id))[0]!;
    const person = await one<{ id: string; full_name: string; extra_of_holder_id: string; chips_count: number }>(
      `select id, full_name, extra_of_holder_id, chips_count from public.chip_order_holders where order_id = $1`, [x.id]);
    expect(person).toMatchObject({ full_name: 'דנה פיצול', extra_of_holder_id: split.holders[0], chips_count: 1 });
    expect(await chipOf(num(42))).toMatchObject({ order_holder_id: person.id, holder_name: 'דנה פיצול' });
    // Cancelling the reception order therefore disables Dana's third chip, and nothing Sara paid for online.
    const w = (await win.getChipOrderWindow(webLine!))!;
    expect(w.holders.find((h) => h.id === split.holders[0])!.extras.map((c) => c.chip_number)).toEqual([num(42)]);
    expect(w.holders.find((h) => h.id === split.holders[1])!.extras).toEqual([]);
  });

  it('a correction of the person\'s name reaches the paid extras too — the reception order\'s holder line and its chip', async () => {
    await win.saveChipOrderWindow(split.id, { holders: [{ ...block(split, 0, []), full_name: 'דנה פיצול-כהן' }] }, admin, PRICE);
    const x = (await extrasOf(split.id))[0]!;
    expect((await one<{ full_name: string }>(`select full_name from public.chip_order_holders where order_id = $1`, [x.id])).full_name).toBe('דנה פיצול-כהן');
    for (const n of [num(40), num(41), num(42)]) expect((await chipOf(n)).holder_name, n).toBe('דנה פיצול-כהן');
    expect((await chipOf(num(43))).holder_name).toBe('שרה פיצול');
  });

  it('a holder the staff added whose only chips are PAID extras cannot be removed — the chips would lose their person', async () => {
    // The line is full (3 of 3): a new holder's number is extra, paid in cash.
    const res = await win.saveChipOrderWindow(split.id, {
      holders: [{ id: null, item_id: split.items[APT(5)]!, role: 'other', full_name: 'מטפלת פיצול', phone: null, email: null, new_chips: [{ number: num(44), chip_type: 'physical' }] }],
      extraPayment: { method: 'cash_transfer', amount: PRICE },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 1, extra: { chips: 1, method: 'cash_transfer' } });
    const staff = await one<{ id: string }>(`select id from public.chip_order_holders where order_id = $1 and source = 'staff'`, [split.id]);
    // Its chip sits on the reception order, not on this line…
    expect(await count(`select count(*) as n from public.chips where order_holder_id = $1`, [staff.id])).toBe(0);
    // …and still the block cannot go.
    await expect(win.saveChipOrderWindow(split.id, { holders: [], removedHolderIds: [staff.id] }, admin, PRICE)).rejects.toBeInstanceOf(win.WindowInputError);
    expect(await count(`select count(*) as n from public.chip_order_holders where id = $1`, [staff.id])).toBe(1);
    expect(await count(`select count(*) as n from public.chip_order_holders where extra_of_holder_id = $1`, [staff.id])).toBe(1);
    // The window shows the chip under that holder, as a paid extra.
    const w = (await win.getChipOrderWindow(split.items[APT(5)]!))!;
    expect(w.holders.find((h) => h.id === staff.id)!.extras.map((c) => c.chip_number)).toEqual([num(44)]);
  });

  it('a TEST order records no payment: "מזומן או העברה" for its extras is refused and makes no real order; "ללא חיוב" goes through', async () => {
    const test = await seedOrder([{ apt: APT(6), role: 'owner', name: 'בדיקה תוספת', phone: '+972539311007', qty: 1 }]);
    // A test order never went through Grow.
    await pool.query(`update public.chip_orders set is_test = true, grow_process_id = null, grow_transaction_id = null where id = $1`, [test.id]);
    const err = await win.saveChipOrderWindow(test.id, {
      holders: [block(test, 0, [num(50), num(51)])],
      extraPayment: { method: 'cash_transfer', amount: PRICE },
    }, admin, PRICE).catch((e) => e);
    expect(err).toBeInstanceOf(ReceptionError);
    expect(err).toMatchObject({ code: 'test_order_payment' });
    expect(await chipsNumbered([num(50), num(51)])).toBe(0);
    expect(await extrasOf(test.id)).toEqual([]);
    expect(await count(`select count(*) as n from public.chip_orders where source = 'reception' and full_name = 'בדיקה תוספת'`, [])).toBe(0);

    const res = await win.saveChipOrderWindow(test.id, {
      holders: [block(test, 0, [num(50), num(51)])],
      extraPayment: { method: 'none', amount: 0 },
    }, admin, PRICE);
    expect(res).toMatchObject({ issued: 2, extra: { chips: 1, method: 'none', order: null } });
    expect(await extrasOf(test.id)).toEqual([]);
  });

  it('the database keeps an extra-chips link to reception orders only', async () => {
    await expect(pool.query(`update public.chip_orders set extra_of_order_id = $2 where id = $1`, [free.id, order.id])).rejects.toThrow(/chip_orders_extra_of_check/);
    await expect(pool.query(`update public.chip_order_holders set extra_of_holder_id = $2 where id = $1`, [free.holders[0], order.holders[0]]))
      .rejects.toThrow(/chip_order_holders_extra_of_check/);
  });
});

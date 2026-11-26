import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Role } from '@/lib/permissions/constants';

// "בטל הזמנת קבלה" (25/11/2026) on the DB and through its route, against a
// throwaway database (WA_TEST_DATABASE_URL), never prod. A reception order —
// cash or a bank transfer — is real: it has no test mode and is collected the
// moment it is made, so cancelling is its only way back.
//   · admin and super admin ONLY, by role — a manager who may record a payment
//     at the reception may not cancel it, whatever the matrix grants;
//   · a reason is required;
//   · the order is stored `rejected` with the reason and who cancelled it, and
//     stays in the Orders tab;
//   · every ACTIVE chip of the order is disabled — never deleted — with a chip
//     event each; a chip that was already disabled is left as it was;
//   · nobody is notified, and the audit row is written in the same transaction;
//   · the money goes back by hand; the order's Morning invoice is credited in
//     the same transaction (26/11/2026) — an order recorded before that, as
//     "מזומן או העברה", has no document and gets no credit;
//   · it cannot be done twice, and never to a web order.
// 27/11/2026 — "ביטול וזיכוי": the route now runs the steps in order (the
// refund, the credit document, the cancellation). Cash and a transfer go back
// by hand; the CREDIT DOCUMENT is issued before the order is cancelled — here
// by a stand-in for the Morning issuer that marks the order's due rows issued
// (the real issuer against a Morning stub: tests/chip-reception-cancel-refund-db.test.ts).
// Only the session is mocked, and the after() hook (never run here — nothing
// reaches Morning; fetch refuses anything).
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
vi.mock('@/lib/auth/session', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/session')>()),
  getSession: async () => (h.user ? { sid: 'test', user: h.user } : null),
}));
/** What the route defers past its answer — recorded, never run. */
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(fn); },
}));
const networkCalls: string[] = [];
/** The Morning issuer, stood in for: the order's due rows are "issued" with a
 *  made-up document — what Morning would answer. */
const issuer = vi.hoisted(() => ({ runs: [] as (string | null)[] }));
vi.mock('@/lib/chipOrders/documents', async (orig) => ({
  ...(await orig<typeof import('@/lib/chipOrders/documents')>()),
  processDueDocuments: async (_limit?: number, orderId: string | null = null) => {
    issuer.runs.push(orderId);
    if (orderId) {
      await pool.query(
        `update public.chip_order_documents
            set status = 'issued', issued_at = now(), claimed_at = null, email_status = 'no_email',
                morning_docs = jsonb_build_array(jsonb_build_object('type', case when kind = 'credit' then 330 else 320 end,
                  'id', gen_random_uuid()::text, 'number', (90000 + floor(random() * 9000))::int::text, 'url', null))
          where order_id = $1 and status = 'pending' and next_attempt_at <= now()`,
        [orderId],
      );
    }
    return { claimed: 0, issued: 0, retried: 0, failed: 0, postponed: 0, idle: null };
  },
}));

const { requireSeededAdmin } = await import('./db-fixtures');
const orders = await import('@/lib/db/chipOrders');
const chipsDb = await import('@/lib/db/chips');
const { saveReceptionWindow, listReceptionRecords } = await import('@/lib/db/chipReception');
const { getChipOrderWindow } = await import('@/lib/db/chipOrderWindow');
const { EMPTY_RECEPTION_ORDERER } = await import('@/lib/chipOrders/reception');
const cancelRoute = await import('@/app/api/chip-orders/[id]/cancel/route');

const tag = String(Date.now()).slice(-6);
const APT = (n: number) => `997${tag}${n}`;
const num = (n: number) => `X${tag}${n}`;
const PRICE = 50;
const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: Role }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
const actor = (key: string) => ({ id: users[key]!.id, name: users[key]!.full_name ?? users[key]!.username });

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await pool.query<T>(sql, params)).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

function cancel(orderId: string, body: unknown) {
  return cancelRoute.POST(
    new Request(`http://local/api/chip-orders/${orderId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: orderId }) },
  );
}

/** An order of the reception: `numbers` issued to one guest, paid in cash (or by a bank transfer). */
async function receptionOrder(apt: string, numbers: string[], method: 'cash' | 'bank_transfer' = 'cash') {
  const r = await saveReceptionWindow(
    { contact_id: made.contacts[apt]!, groups: [{ resident_role: 'other', holder_name: 'אורח קבלה', chip_type: 'physical', numbers }] },
    { orderer: { ...EMPTY_RECEPTION_ORDERER, name: 'משלם בקבלה' }, payment: { method, amount: numbers.length * PRICE } },
    PRICE,
    actor('manager'),
  );
  made.orders.push(r.order!.id);
  return { id: r.order!.id, orderNumber: r.order!.order_number, chipIds: r.items.map((c) => c.id) };
}
/** The Morning document rows of an order, oldest first. */
const documentsOf = async (orderId: string) => (await pool.query<{ id: string; kind: string; payment_key: string; amount: number; payment_method: string; status: string; credit_of: string | null }>(
  `select id, kind, payment_key, amount::float8 as amount, payment_method, status, credit_of
     from public.chip_order_documents where order_id = $1 order by created_at`, [orderId])).rows;

const orderRow = (id: string) => one<{
  status: string; source: string; total: number; rejected_at: Date | null; reject_reason: string | null;
  cancelled_by: string | null; cancelled_by_name: string | null; refund_status: string | null; collected_at: Date | null;
}>(
  `select status, source, total::float8 as total, rejected_at, reject_reason, cancelled_by, cancelled_by_name, refund_status, collected_at
     from public.chip_orders where id = $1`,
  [id],
);
const chipRows = async (ids: string[]) => (await pool.query<{ id: string; status: string; deactivation_reason: string | null; deactivated_by: string | null }>(
  `select id, status, deactivation_reason, deactivated_by from public.chips where id = any($1::uuid[]) order by chip_number`, [ids])).rows;
const trail = async (orderId: string) => (await pool.query<{ action: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
  `select action, actor_user_id, metadata from public.audit_log
    where entity_type = 'chip_order' and entity_id = $1 and action = 'reception_cancelled'`, [orderId])).rows;

d('cancelling a reception order, on the DB and through its route', () => {
  let first: Awaited<ReturnType<typeof receptionOrder>>;
  let second: Awaited<ReturnType<typeof receptionOrder>>;
  let webOrderId = '';

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      networkCalls.push(String(input instanceof Request ? input.url : input));
      throw new TypeError('no network in this test');
    }));
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    for (const [key, role] of [['admin', 'admin'], ['manager', 'manager'], ['guard', 'guard']] as const) {
      const username = `rc-${key}-${tag}`;
      const u = await one<{ id: string }>(
        `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', $3, $4, true) returning id`,
        [username, role === 'guard' ? null : `${username}@example.test`, `ביטול ${key}`, role],
      );
      made.users.push(u.id);
      users[key] = { id: u.id, username, email: null, full_name: `ביטול ${key}`, role };
    }
    // The manager holds every chips permission of the matrix — it still may not cancel.
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager!.id, mod]);
    }
    for (let i = 1; i <= 4; i++) {
      made.contacts[APT(i)] = (await one<{ id: string }>(`insert into public.contacts (apartment_number, owner_name) values ($1, 'בעלים רשום') returning id`, [APT(i)])).id;
    }
    first = await receptionOrder(APT(1), [num(1), num(2), num(3)]);
    second = await receptionOrder(APT(2), [num(4)], 'bank_transfer');
    // A paid web order, for the refusal.
    const o = await one<{ id: string }>(
      `insert into public.chip_orders (full_name, phone_e164, email, address, role, status, total, tracking_token, paid_at, due_at, grow_process_id, grow_transaction_id)
       values ('מזמין מהאתר', '+972539300099', 'web@example.test', 'כתובת 1', 'owner', 'paid', 50, $1, now(), now() + interval '3 days', $2, $3) returning id`,
      [randomBytes(32).toString('base64url'), `rc-p-${tag}`, `rc-t-${tag}`],
    );
    webOrderId = o.id;
    made.orders.push(o.id);
    await pool.query(
      `insert into public.chip_order_items (order_id, contact_id, apartment_number, chips_count, unit_price, threshold, price_above, line_total, match_status)
       values ($1, $2, $3, 1, 50, 1, 50, 50, 'matched')`, [o.id, made.contacts[APT(3)], APT(3)]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    const rows = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows;
    for (const c of rows) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [c.id]);
      await pool.query(`delete from public.chips where id = $1`, [c.id]);
    }
    for (const id of made.orders) {
      // Document rows block deleting their order (FK restrict): credits first, then the rest — by the order's id.
      await pool.query(`delete from public.chip_order_documents where order_id = $1 and credit_of is not null`, [id]);
      await pool.query(`delete from public.chip_order_documents where order_id = $1`, [id]);
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.users) {
      await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
      await pool.query(`delete from public.users where id = $1`, [id]);
    }
    await pool.end();
  });

  it('admin and super admin only: a manager with every chips permission, the guard and nobody signed in are refused, and nothing changes', async () => {
    for (const [key, status] of [['manager', 403], ['guard', 403], [null, 401]] as const) {
      as(key);
      expect((await cancel(first.id, { reason: 'ניסיון ביטול' })).status, String(key)).toBe(status);
    }
    expect(await orderRow(first.id)).toMatchObject({ status: 'collected', rejected_at: null, reject_reason: null, cancelled_by_name: null });
    expect((await chipRows(first.chipIds)).every((c) => c.status === 'active')).toBe(true);
    expect(await trail(first.id)).toEqual([]);
  });

  it('a reason is required', async () => {
    as('admin');
    for (const body of [{}, { reason: '' }, { reason: ' א' }]) expect((await cancel(first.id, body)).status).toBe(400);
    expect((await orderRow(first.id)).status).toBe('collected');
  });

  it('the order is stored rejected with the reason and who cancelled; its active chips are disabled, never deleted; nobody is notified; the trail is written with it', async () => {
    // One of the three chips was disabled before — it is left exactly as it was.
    await chipsDb.deactivateChip(first.chipIds[2]!, { reason: 'lost' }, actor('manager'));
    const eventsBefore = await count(`select count(*) as n from public.chip_events where chip_id = any($1::uuid[])`, [first.chipIds]);

    as('admin');
    afterQueue.length = 0;
    const res = await cancel(first.id, { reason: '  נרשם בטעות על הדירה הלא נכונה  ' });
    expect(res.status).toBe(200);
    // Cash goes back by hand: no processor refund. The credit document was
    // issued BEFORE the order was cancelled (the issuer ran for this order).
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, chips_disabled: 2, refund: 'by_hand', failed_step: null, message: null });
    expect(body.credit_numbers).toHaveLength(1);
    expect(issuer.runs).toContain(first.id);
    // What else is due in the queue is issued past the answer (not run here).
    expect(afterQueue).toHaveLength(1);

    // The order's invoice is credited: ONE credit row, of the whole sum.
    const [invoice, credit, ...more] = await documentsOf(first.id);
    expect(more).toEqual([]);
    expect(invoice).toMatchObject({ kind: 'invoice', payment_key: `reception:${first.id}`, amount: 3 * PRICE, payment_method: 'cash', credit_of: null });
    expect(credit).toMatchObject({
      kind: 'credit', payment_key: `cancel:${first.id}`, amount: 3 * PRICE, payment_method: 'cash', status: 'issued', credit_of: invoice!.id,
    });

    const o = await orderRow(first.id);
    expect(o).toMatchObject({
      status: 'rejected', source: 'reception', total: 3 * PRICE, reject_reason: 'נרשם בטעות על הדירה הלא נכונה',
      cancelled_by: users.admin!.id, cancelled_by_name: 'ביטול admin', refund_status: null,
    });
    expect(o.rejected_at).not.toBeNull();
    // What it was stays on record: it WAS paid and handed over.
    expect(o.collected_at).not.toBeNull();

    // The chips: all three still exist; the two active ones are disabled by whoever cancelled.
    const rows = await chipRows(first.chipIds);
    expect(rows).toHaveLength(3);
    expect(rows.map((c) => c.status)).toEqual(['inactive', 'inactive', 'inactive']);
    expect(rows.slice(0, 2).every((c) => c.deactivated_by === users.admin!.id && c.deactivation_reason === 'unknown')).toBe(true);
    expect(rows[2]).toMatchObject({ deactivation_reason: 'lost', deactivated_by: users.manager!.id });
    // One chip event per chip that was disabled now, naming the order.
    expect(await count(`select count(*) as n from public.chip_events where chip_id = any($1::uuid[])`, [first.chipIds])).toBe(eventsBefore + 2);
    const ev = await one<{ new_value: { note?: string } }>(
      `select new_value from public.chip_events where chip_id = $1 and event_type = 'deactivated' order by created_at desc limit 1`, [first.chipIds[0]]);
    expect(ev.new_value.note).toBe(`ביטול הזמנת קבלה ${first.orderNumber}`);
    // The chips keep their link to the order (they are disabled, not detached).
    expect(await count(`select count(*) as n from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1`, [first.id])).toBe(3);

    expect(await count(`select count(*) as n from public.chip_order_notifications where order_id = $1`, [first.id])).toBe(0);
    expect(await trail(first.id)).toEqual([{
      action: 'reception_cancelled',
      actor_user_id: users.admin!.id,
      metadata: {
        source: 'reception', order_number: first.orderNumber, reason: 'נרשם בטעות על הדירה הלא נכונה', amount: 3 * PRICE,
        chips_disabled: 2, chips_left_moved: 0, payment_method: 'cash',
        steps: { refund: 'by_hand', credit_numbers: body.credit_numbers, credit_email: 'no_email' },
      },
    }]);
  });

  it('the row stays in the Orders tab with its status, after the open orders; the window and the holder block say it was cancelled', async () => {
    const rows = await orders.listOpenChipOrderRows();
    const mine = rows.filter((r) => made.orders.includes(r.order_id));
    expect(mine.map((r) => [r.order_id, r.source, r.status])).toEqual([
      [webOrderId, 'web', 'paid'],
      [second.id, 'reception', 'collected'],
      [first.id, 'reception', 'rejected'],
    ]);
    const item = mine.find((r) => r.order_id === first.id)!.item_id;
    const w = (await getChipOrderWindow(item))!;
    expect(w.order).toMatchObject({ status: 'rejected', source: 'reception', reject_reason: 'נרשם בטעות על הדירה הלא נכונה', cancelled_by_name: 'ביטול admin' });
    expect(w.order.rejected_at).not.toBeNull();
    const records = await listReceptionRecords(made.contacts[APT(1)]!);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'order', order_number: first.orderNumber, cancelled: true, payment_method: 'cash' });
    expect((await listReceptionRecords(made.contacts[APT(2)]!))[0]).toMatchObject({ cancelled: false, payment_method: 'bank_transfer' });
    // The order that stands keeps its one invoice, uncredited.
    expect((await documentsOf(second.id)).map((x) => [x.kind, x.payment_method, x.amount])).toEqual([['invoice', 'bank_transfer', PRICE]]);
  });

  it('it cannot be done twice, never to a web order, and an unknown order is 404', async () => {
    as('super');
    const again = await cancel(first.id, { reason: 'פעם שנייה' });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toMatch(/כבר בוטלה/);
    expect(await trail(first.id)).toHaveLength(1);
    expect((await orderRow(first.id)).reject_reason).toBe('נרשם בטעות על הדירה הלא נכונה');

    const web = await cancel(webOrderId, { reason: 'הזמנה מהאתר' });
    expect(web.status).toBe(409);
    expect((await web.json() as { error: string }).error).toMatch(/הזמנת קבלה/);
    expect((await orderRow(webOrderId)).status).toBe('paid');

    expect((await cancel('00000000-0000-4000-8000-0000000000aa', { reason: 'לא קיימת' })).status).toBe(404);
    expect((await cancel('not-an-id', { reason: 'לא קיימת' })).status).toBe(404);
  });

  it('a chip of a cancelled order can be switched back on by hand — it was disabled, not removed', async () => {
    const back = await chipsDb.reactivateChip(first.chipIds[0]!, {}, actor('admin'));
    expect(back?.status).toBe('active');
    // The order stays cancelled.
    expect((await orderRow(first.id)).status).toBe('rejected');
  });

  it('the database refuses a cancellation mark on a web order', async () => {
    await expect(pool.query(`update public.chip_orders set cancelled_by_name = 'מישהו' where id = $1`, [webOrderId])).rejects.toThrow(/chip_orders_cancelled_check/);
  });

  it('a chip that was moved to another apartment since is somebody else\'s now: the cancellation leaves it alone, and says so in the trail', async () => {
    const third = await receptionOrder(APT(3), [num(7), num(8)]);
    // The second chip was moved to apartment 2 after the order was made.
    await pool.query(`update public.chips set contact_id = $2 where id = $1`, [third.chipIds[1], made.contacts[APT(2)]]);
    as('admin');
    const res = await cancel(third.id, { reason: 'בוטלה אחרי העברת צ׳יפ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chips_disabled: 1, refund: 'by_hand' });
    const rows = await chipRows(third.chipIds);
    expect(rows.map((c) => c.status)).toEqual(['inactive', 'active']);
    expect((await trail(third.id))[0]!.metadata).toMatchObject({ chips_disabled: 1, chips_left_moved: 1 });
    expect((await orderRow(third.id)).status).toBe('rejected');
  });

  it('an order recorded before 26/11/2026 ("מזומן או העברה", no document) is cancelled with no credit row', async () => {
    const legacy = await receptionOrder(APT(4), [num(9)]);
    // What such an order looks like: the old method, and no Morning document.
    await pool.query(`delete from public.chip_order_documents where order_id = $1`, [legacy.id]);
    await pool.query(`update public.chip_orders set payment_method = 'cash_transfer' where id = $1`, [legacy.id]);
    as('super');
    const res = await cancel(legacy.id, { reason: 'הזמנה ישנה' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chips_disabled: 1, refund: 'by_hand', credit_numbers: [], credit_email: null });
    expect(await documentsOf(legacy.id)).toEqual([]);
    expect((await orderRow(legacy.id)).status).toBe('rejected');
    expect((await trail(legacy.id))[0]!.metadata).toMatchObject({ payment_method: 'cash_transfer', chips_disabled: 1 });
  });

  it('no request of this file ever left for the network', () => {
    expect(networkCalls).toEqual([]);
  });
});

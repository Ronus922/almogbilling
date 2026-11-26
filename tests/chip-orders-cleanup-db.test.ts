import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Removing chip orders (13/11/2026), on a throwaway database
// (WA_TEST_DATABASE_URL), never prod:
//   - the hourly purge of REAL orders still unpaid 48 hours after creation
//     (49h → deleted with its lease files, files first; 47h → kept; paid a
//     month ago → kept; a test order → kept; an order of the former processor
//     (Grow) → never deleted; a card session that cannot be checked → kept;
//     Storage refusing → kept);
//   - "מחק את כל הזמנות הבדיקה": test orders go, a real order stays, a chip
//     issued for a test order stays in the chips module (order_item_id → NULL).
// PayPlus is not configured here (payplusConfigFor answers null) — the lookups
// before a purge are tests/chip-order-live-card-db.test.ts — except in the
// tests that turn it on (`pp.on`): its lookup then answers "nothing charged"
// for every session and records what it was asked about. Those pin the rules
// of 26/11 (review): an order whose payment page may still be open is never
// purged, an order with sessions one lookup cannot cover is never read as
// "not charged", and an approved charge for an order the purge deleted alerts
// the admins. Storage and the notifications are mocked; every row is real.
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

// Neither PayPlus environment is configured in this file — unless a test sets
// pp.on; the lookup never leaves the process.
const pp = vi.hoisted(() => ({ on: false, asked: [] as string[] }));
vi.mock('@/lib/payplus/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/payplus/client')>()),
  payplusConfigFor: (mode: 'sandbox' | 'production') =>
    (pp.on ? { mode, origin: 'https://payplus.invalid', apiKey: 'cleanup-test-key', secretKey: 'cleanup-test-secret', pageUid: 'cleanup-test-page' } : null),
  lookupPaymentRequest: async (_cfg: unknown, pageRequestUid: string) => {
    pp.asked.push(pageRequestUid);
    return { kind: 'transactions', transactions: [] };
  },
}));
// The admins' alerts — recorded here, not written.
const createNotification = vi.fn<(n: { type: string; priority?: string; dedupeKey?: string; sourceEntityId?: string }) => Promise<undefined>>(async () => undefined);
vi.mock('@/services/notifications', async (orig) => ({
  ...(await orig<typeof import('@/services/notifications')>()),
  createNotification,
}));

/** Every Storage removal: the keys, and whether the order row still existed
 *  at that moment (files FIRST, then the row). */
const removals: { keys: string[]; rowExisted: boolean }[] = [];
const storage = { ok: true };
vi.mock('@/lib/storage/chipOrderLeaseStorage', () => ({
  removeChipOrderLeasesStrict: async (keys: string[]) => {
    const r = await pool.query(`select 1 from public.chip_order_items where lease_file_key = any($1::text[])`, [keys]);
    removals.push({ keys, rowExisted: (r.rowCount ?? 0) > 0 });
    return storage.ok;
  },
}));
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined), afterOrderPaid: vi.fn(async () => undefined) }));

const db = await import('@/lib/db/chipOrders');
const { setCardSession } = await import('@/lib/db/chipOrderCard');
const { purgeUnpaidChipOrders, deleteAllTestChipOrders, deleteTestChipOrder } = await import('@/lib/chipOrders/cleanup');
const { applyPayPlusCallback } = await import('@/lib/chipOrders/cardPayment');
const { readPayPlusTransaction } = await import('@/lib/payplus/client');
const { issueChipGroups } = await import('@/lib/db/chips');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}1`;
const made = { contacts: [] as string[], orders: [] as string[], chips: [] as string[] };
let contactId = '';
let admin: { id: string; name: string };

async function order(opts: { hoursAgo: number; lease?: boolean; isTest?: boolean }): Promise<string> {
  const o = await db.createChipOrder(
    {
      fullName: 'בדיקת ניקוי', phoneE164: '+972539300001', email: 'cleanup@example.test', address: 'הרצל 1 חיפה',
      role: opts.lease ? 'tenant' : 'owner', ip: null, isTest: opts.isTest,
      lines: [{
        apartmentNumber: APT, chipsCount: 1, leaseEndDate: opts.lease ? '2030-01-01' : null,
        lease: opts.lease ? { objectKey: `${crypto.randomUUID()}.pdf`, fileName: 'חוזה.pdf', mime: 'application/pdf', size: 100 } : null,
      }],
    },
    DEFAULT_CHIP_ORDER_SETTINGS,
  );
  made.orders.push(o.id);
  await pool.query(`update public.chip_orders set created_at = now() - make_interval(hours => $2) where id = $1`, [o.id, opts.hoursAgo]);
  return o.id;
}
const exists = async (id: string) => ((await pool.query(`select 1 from public.chip_orders where id = $1`, [id])).rowCount ?? 0) > 0;
const statusOf = async (id: string) => (await pool.query<{ status: string }>(`select status from public.chip_orders where id = $1`, [id])).rows[0]?.status;
/** Ages every payment session of the order — and its latest-session stamp — to `minutes` ago. */
async function sessionsAgo(id: string, minutes: number) {
  await pool.query(`update public.chip_order_card_sessions set created_at = now() - make_interval(mins => $2) where order_id = $1`, [id, minutes]);
  await pool.query(`update public.chip_orders set card_session_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);
}
const activeAdmins = async () => (await pool.query<{ id: string }>(
  `select id from public.users where is_active = true and role in ('super_admin', 'admin')`,
)).rows.length;

d('chip orders — hourly purge of unpaid orders, and deleting test orders', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    admin = { id: await requireSeededAdmin(pool), name: 'e2e-admin' };
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539300001') returning id`,
      [APT],
    );
    contactId = c.rows[0]!.id;
    made.contacts.push(contactId);
  });

  beforeEach(() => {
    storage.ok = true;
    removals.length = 0;
    pp.on = false;
    pp.asked.length = 0;
    createNotification.mockClear();
  });

  afterAll(async () => {
    if (!pool) return;
    for (const id of made.chips) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('unpaid 49h → deleted with its lease (file first); 47h → kept; paid a month ago → kept; test → kept', async () => {
    const old = await order({ hoursAgo: 49, lease: true });
    const fresh = await order({ hoursAgo: 47, lease: true });
    const paid = await order({ hoursAgo: 24 * 30 });
    await pool.query(
      `update public.chip_orders set status = 'paid', paid_at = now() - interval '29 days', grow_transaction_id = 'tx-old' where id = $1`,
      [paid],
    );
    const test = await order({ hoursAgo: 49, isTest: true, lease: true });
    const oldKey = (await pool.query<{ k: string }>(`select lease_file_key as k from public.chip_order_items where order_id = $1`, [old])).rows[0]!.k;

    const r = await purgeUnpaidChipOrders();
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBe(false);
    expect((await pool.query(`select 1 from public.chip_order_items where order_id = $1`, [old])).rowCount).toBe(0);
    expect(removals.find((x) => x.keys.includes(oldKey))).toEqual({ keys: [oldKey], rowExisted: true });

    expect(await exists(fresh)).toBe(true);
    expect(await statusOf(paid)).toBe('paid');
    expect(await exists(test)).toBe(true);
    // Neither the 47h order's nor the test order's lease was touched.
    const keptKeys = (await pool.query<{ k: string }>(
      `select lease_file_key as k from public.chip_order_items where order_id = any($1::uuid[])`, [[fresh, test]],
    )).rows.map((x) => x.k);
    expect(removals.flatMap((x) => x.keys).filter((k) => keptKeys.includes(k))).toEqual([]);
  });

  it('an order of the former processor (a Grow process) can no longer be checked — it is never deleted, run after run', async () => {
    const id = await order({ hoursAgo: 50 });
    await pool.query(`update public.chip_orders set grow_process_id = $2, grow_process_token = 'tok' where id = $1`, [id, `p-${id}`]);
    for (let run = 0; run < 2; run++) {
      const r = await purgeUnpaidChipOrders();
      expect(r.skippedUnverifiable).toBeGreaterThanOrEqual(1);
      expect(r.paidOrderIds).not.toContain(id);
      expect(await statusOf(id)).toBe('pending_payment');
    }
  });

  it('an unpaid order that had a card session is kept while PayPlus of its environment is not configured', async () => {
    const id = await order({ hoursAgo: 50 });
    expect(await setCardSession(id, { env: 'production', pageRequestUid: `cleanup-${tag}-session-1`, amount: 50 })).toBe(true);
    await sessionsAgo(id, 120); // its page expired long ago
    const r = await purgeUnpaidChipOrders();
    expect(r.skippedUnverifiable).toBeGreaterThanOrEqual(1);
    expect(await exists(id)).toBe(true);
    expect(await statusOf(id)).toBe('pending_payment');
  });

  it('an order whose payment page was opened in the last 45 minutes is NOT purged: not a candidate, and the delete itself refuses it under the row lock — once the page expired, it is looked up and purged', async () => {
    const id = await order({ hoursAgo: 50 });
    const session = `cleanup-${tag}-open-1`;
    expect(await setCardSession(id, { env: 'production', pageRequestUid: session, amount: 50 })).toBe(true);
    pp.on = true;
    expect((await db.listStaleUnpaidOrders(48)).map((o) => o.id)).not.toContain(id);
    await purgeUnpaidChipOrders();
    expect(await exists(id)).toBe(true);
    expect(pp.asked).not.toContain(session);
    // Straight at the delete (a page opened between the purge's lookup and its delete): refused.
    expect(await db.deleteChipOrderWithLeases(id, 'unpaid', async () => true)).toBe('not_found');
    expect(await exists(id)).toBe(true);
    // 46 minutes on the page has expired: a candidate again — asked about, nothing charged, deleted.
    await sessionsAgo(id, 46);
    expect((await db.listStaleUnpaidOrders(48)).map((o) => o.id)).toContain(id);
    await purgeUnpaidChipOrders();
    expect(pp.asked).toContain(session);
    expect(await exists(id)).toBe(false);
  });

  it('PayPlus says "nothing charged", yet an order with sessions one lookup cannot cover — more than 25, or one older than its week — is KEPT (unverifiable), run after run; a covered one is deleted', async () => {
    const many = await order({ hoursAgo: 50 });
    for (let i = 1; i <= 26; i++) {
      expect(await setCardSession(many, { env: 'production', pageRequestUid: `cleanup-${tag}-many-${String(i).padStart(2, '0')}`, amount: 50 })).toBe(true);
    }
    await sessionsAgo(many, 120);
    const ancient = await order({ hoursAgo: 24 * 9 });
    expect(await setCardSession(ancient, { env: 'production', pageRequestUid: `cleanup-${tag}-ancient-1`, amount: 50 })).toBe(true);
    await sessionsAgo(ancient, 8 * 24 * 60);
    const covered = await order({ hoursAgo: 50 });
    expect(await setCardSession(covered, { env: 'production', pageRequestUid: `cleanup-${tag}-covered-1`, amount: 50 })).toBe(true);
    await sessionsAgo(covered, 120);

    pp.on = true;
    const r = await purgeUnpaidChipOrders();
    expect(await exists(covered)).toBe(false);
    expect(await exists(many)).toBe(true);
    expect(await exists(ancient)).toBe(true);
    expect(r.skippedUnverifiable).toBeGreaterThanOrEqual(2);
    // The newest 25 sessions of `many` were asked about — the 26th could not be; the week-old one was not reached at all.
    expect(pp.asked.filter((u) => u.startsWith(`cleanup-${tag}-many-`))).toHaveLength(25);
    expect(pp.asked).not.toContain(`cleanup-${tag}-ancient-1`);
    expect(pp.asked).toContain(`cleanup-${tag}-covered-1`);
    await purgeUnpaidChipOrders();
    expect(await exists(many)).toBe(true);
    expect(await exists(ancient)).toBe(true);
    expect(await statusOf(many)).toBe('pending_payment');
  });

  it('an APPROVED production charge for an order that no longer exists (the purge deleted it) alerts every active admin — not a log line only; a refused charge, or the sandbox, alerts nobody', async () => {
    const gone = await order({ hoursAgo: 50 });
    const number = (await pool.query<{ n: number }>(`select order_number as n from public.chip_orders where id = $1`, [gone])).rows[0]!.n;
    expect(await db.deleteChipOrderWithLeases(gone, 'unpaid', async () => true)).toBe('deleted');
    const charge = (uid: string, statusCode: string, session: string | null) => readPayPlusTransaction({
      transaction_type: 'Charge',
      transaction: {
        uid, ...(session ? { payment_request_uid: session } : {}), type: 'internal_page', status_code: statusCode,
        amount: 50, currency: 'ILS', approval_number: '0012345', more_info: String(number),
      },
    })!;
    const production = { mode: 'production', origin: 'https://payplus.invalid', apiKey: 'k', secretKey: 's', pageUid: 'p' } as const;
    // The hosted-fields notice (no session named), and one that names a session.
    expect(await applyPayPlusCallback(production, charge(`cleanup-${tag}-late-1`, '000', null))).toEqual({ kind: 'ignored', why: 'unknown_order' });
    expect(await applyPayPlusCallback(production, charge(`cleanup-${tag}-late-2`, '000', `cleanup-${tag}-late-session`))).toEqual({ kind: 'ignored', why: 'unknown_order' });
    const admins = await activeAdmins();
    expect(admins).toBeGreaterThanOrEqual(1);
    const keys = createNotification.mock.calls.map((c) => c[0].dedupeKey ?? '');
    expect(keys.filter((k) => k.startsWith(`chip_card_unknown_order:cleanup-${tag}-late-1:`))).toHaveLength(admins);
    expect(keys.filter((k) => k.startsWith(`chip_card_unknown_order:cleanup-${tag}-late-2:`))).toHaveLength(admins);
    expect(createNotification.mock.calls[0]![0]).toMatchObject({ type: 'chip_order_alert', priority: 'high' });

    createNotification.mockClear();
    await applyPayPlusCallback(production, charge(`cleanup-${tag}-late-3`, '033', null));
    await applyPayPlusCallback({ ...production, mode: 'sandbox' }, charge(`cleanup-${tag}-late-4`, '000', null));
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('Storage refusing a lease keeps the order for the next run, and the run goes on', async () => {
    const stuck = await order({ hoursAgo: 60, lease: true });
    const other = await order({ hoursAgo: 60 });
    storage.ok = false;
    const r = await purgeUnpaidChipOrders();
    expect(r.fileFailed).toBeGreaterThanOrEqual(1);
    expect(await exists(stuck)).toBe(true);
    expect(await exists(other)).toBe(false);
    storage.ok = true;
    await purgeUnpaidChipOrders();
    expect(await exists(stuck)).toBe(false);
  });

  it('deleting test orders never touches a real order; a chip issued for a test order stays (order_item_id → NULL)', async () => {
    const real = await order({ hoursAgo: 1 });
    const t1 = await order({ hoursAgo: 1, isTest: true, lease: true });
    const t2 = await order({ hoursAgo: 1, isTest: true });
    // t2 goes all the way: "paid" by the test button, one chip issued (there
    // is no approval step since 13/11/2026).
    const token = (await pool.query<{ t: string }>(`select tracking_token as t from public.chip_orders where id = $1`, [t2])).rows[0]!.t;
    expect(await db.markTestChipOrderPaid(token)).toBe(t2);
    expect(await db.markTestChipOrderPaid(token)).toBeNull();
    const item = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [t2])).rows[0]!;
    const issued = await issueChipGroups(
      { contact_id: contactId, groups: [{ resident_role: 'owner', chip_type: 'physical', numbers: [`T${tag}1`], order_item_id: item.id }] },
      admin,
    );
    made.chips.push(...issued.items.map((c) => c.id));

    // The test button can never "pay" a real order.
    const realToken = (await pool.query<{ t: string }>(`select tracking_token as t from public.chip_orders where id = $1`, [real])).rows[0]!.t;
    expect(await db.markTestChipOrderPaid(realToken)).toBeNull();
    expect(await statusOf(real)).toBe('pending_payment');
    // One test order by id: a real order's id is refused.
    expect(await deleteTestChipOrder(real)).toEqual({ deleted: 0, fileFailed: 0, notFound: 1 });

    const r = await deleteAllTestChipOrders();
    expect(r.deleted).toBeGreaterThanOrEqual(2);
    expect(await exists(t1)).toBe(false);
    expect(await exists(t2)).toBe(false);
    expect(await exists(real)).toBe(true);
    const chip = (await pool.query<{ order_item_id: string | null; status: string }>(
      `select order_item_id, status from public.chips where id = $1`, [issued.items[0]!.id],
    )).rows[0];
    expect(chip).toEqual({ order_item_id: null, status: 'active' });
  });

  it('the database refuses Grow fields on a test order and "not required" on a real one', async () => {
    const t = await order({ hoursAgo: 1, isTest: true });
    await expect(pool.query(`update public.chip_orders set grow_process_id = 'x' where id = $1`, [t])).rejects.toThrow(/chip_orders_test_no_grow_check/);
    const real = await order({ hoursAgo: 1 });
    await expect(pool.query(`update public.chip_orders set refund_status = 'not_required' where id = $1`, [real])).rejects.toThrow(/chip_orders_refund_not_required_check/);
    // A real web order is "paid" only with a Grow transaction or a card charge the
    // processor confirmed (card_status 'paid') — never with neither (card_status NULL).
    await expect(pool.query(`update public.chip_orders set status = 'paid', paid_at = now() where id = $1`, [real])).rejects.toThrow(/chip_orders_paid_fields_check/);
  });
});

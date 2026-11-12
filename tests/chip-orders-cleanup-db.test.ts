import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';

// Removing chip orders (13/11/2026), on a throwaway database
// (WA_TEST_DATABASE_URL), never prod:
//   - the hourly purge of REAL orders still unpaid 48 hours after creation
//     (49h → deleted with its lease files, files first; 47h → kept; paid a
//     month ago → kept; a test order → kept; a Grow process with Grow off or
//     failing → kept; Grow says paid → moved to paid; Storage refusing → kept);
// Grow, Storage and the notifications are mocked; every row is real.
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

const grow = { configured: false, paid: false, fail: false };
vi.mock('@/lib/grow/client', () => ({
  isGrowConfigured: () => grow.configured,
  getPaymentProcessInfo: async () => {
    if (grow.fail) throw new Error('grow is down');
    return { transactions: [] };
  },
  findPaidTransaction: () => (grow.paid ? { transactionId: 'tx-paid', transactionToken: 'tt-paid', asmachta: '777' } : null),
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
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined) }));

const db = await import('@/lib/db/chipOrders');
const { purgeUnpaidChipOrders } = await import('@/lib/chipOrders/cleanup');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const APT = `992${tag}1`;
const made = { contacts: [] as string[], orders: [] as string[], chips: [] as string[] };
let contactId = '';

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

d('chip orders — hourly purge of unpaid orders', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539300001') returning id`,
      [APT],
    );
    contactId = c.rows[0]!.id;
    made.contacts.push(contactId);
  });

  beforeEach(() => {
    Object.assign(grow, { configured: false, paid: false, fail: false });
    storage.ok = true;
    removals.length = 0;
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

  it('a Grow process: Grow off or failing → kept; Grow says unpaid → deleted; Grow says paid → moved to paid', async () => {
    const withProcess = async () => {
      const id = await order({ hoursAgo: 50 });
      await pool.query(`update public.chip_orders set grow_process_id = $2, grow_process_token = 'tok' where id = $1`, [id, `p-${id}`]);
      return id;
    };
    const a = await withProcess();
    let r = await purgeUnpaidChipOrders();
    expect(r.skippedGrowUnavailable).toBeGreaterThanOrEqual(1);
    expect(await statusOf(a)).toBe('pending_payment');

    grow.configured = true;
    grow.fail = true;
    r = await purgeUnpaidChipOrders();
    expect(r.skippedGrowError).toBeGreaterThanOrEqual(1);
    expect(await statusOf(a)).toBe('pending_payment');

    grow.fail = false;
    grow.paid = true;
    r = await purgeUnpaidChipOrders();
    expect(r.paidOrderIds).toContain(a);
    expect(await statusOf(a)).toBe('paid');

    const b = await withProcess();
    grow.paid = false;
    r = await purgeUnpaidChipOrders();
    expect(await exists(b)).toBe(false);
    expect(await statusOf(a)).toBe('paid');
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

});

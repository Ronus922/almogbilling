import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Test mode of /chip-order (13/11/2026), against a throwaway database
// (WA_TEST_DATABASE_URL), never prod. The token's life (made, hashed, checked
// in constant time, replaced, killed) and the public routes behind it:
//   - no token / a wrong token / a valid token after the switch went off → 403;
//   - a valid token → the order is created is_test, Grow is never called;
//   - "סיים הזמנת בדיקה" marks only THAT test order paid — never a real one.
// Grow is not configured here (no GROW_* env), so the page is "closed" for
// everyone without the token — exactly production today. Grow's client, the
// code sender and the after() hook are mocked; every row is real.
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

const createPaymentProcess = vi.fn(async () => ({ processId: 'p', processToken: 't', url: 'https://sandbox.meshulam.co.il/x' }));
vi.mock('@/lib/grow/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/grow/client')>()),
  createPaymentProcess,
  isGrowConfigured: () => false,
}));
vi.mock('@/lib/portal/send', () => ({
  sendPortalCode: vi.fn(async () => ({ ok: true })),
  alertManagerAboutLockout: vi.fn(async () => undefined),
}));
const PHONE = '+972539400001';
vi.mock('@/lib/chipOrders/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/chipOrders/server')>()),
  // The OTP cookie is next/headers state; the submit only needs "this phone was verified".
  readVerifiedPhone: async () => PHONE,
}));
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(fn); },
}));
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined) }));

const testMode = await import('@/lib/chipOrders/testMode');
const { POST: otpRequest } = await import('@/app/api/public/chip-order/otp/request/route');
const { POST: submit } = await import('@/app/api/public/chip-order/route');
const { POST: finish } = await import('@/app/api/public/chip-order/test-finish/route');
const db = await import('@/lib/db/chipOrders');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const tag = String(Date.now()).slice(-6);
const APT = `993${tag}1`;
const made = { contacts: [] as string[], orders: [] as string[], otpPhones: [PHONE] };
let adminId = '';
let hadTestRow = false;
let savedTestRow: unknown = null;
const ips = { a: `203.0.113.${(Date.now() % 200) + 20}` };

const tokenOf = (link: string) => new URL(link).searchParams.get('test')!;
const H = (token?: string): Record<string, string> => ({ 'x-real-ip': ips.a, ...(token ? { 'x-chip-order-test': token } : {}) });

async function submitOrder(token?: string): Promise<Response> {
  const fd = new FormData();
  fd.append('order', JSON.stringify({
    fullName: 'בדיקה בודקת', phone: '0539400001', email: 'test-mode@example.test', address: 'הרצל 1 חיפה',
    role: 'owner', acceptTerms: true, lines: [{ apartment: APT, chipsCount: 2, leaseEndDate: null }],
  }));
  // The route refuses a body without a Content-Length — serialize it first.
  const encoded = new Response(fd);
  const body = Buffer.from(await encoded.arrayBuffer());
  return submit(new Request('http://localhost/api/public/chip-order', {
    method: 'POST',
    headers: { ...H(token), 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) },
    body,
  }));
}
const finishOrder = (trackingToken: string, token?: string) =>
  finish(new Request('http://localhost/api/public/chip-order/test-finish', {
    method: 'POST',
    headers: { ...H(token), 'content-type': 'application/json' },
    body: JSON.stringify({ trackingToken }),
  }));
const askCode = (token?: string) =>
  otpRequest(new Request('http://localhost/api/public/chip-order/otp/request', {
    method: 'POST',
    headers: { ...H(token), 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '0539400001' }),
  }));

d('chip orders — test mode (link token + routes)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    adminId = await requireSeededAdmin(pool);
    const prev = await pool.query(`select value from public.app_settings where key = 'chip_orders_test_mode'`);
    hadTestRow = (prev.rowCount ?? 0) > 0;
    savedTestRow = prev.rows[0]?.value ?? null;
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539400001') returning id`,
      [APT],
    );
    made.contacts.push(c.rows[0]!.id);
  });

  afterAll(async () => {
    if (!pool) return;
    for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.query(`delete from public.portal_otp_codes where phone_e164 = any($1::text[])`, [made.otpPhones]);
    await pool.query(`delete from public.auth_rate_limits where bucket like $1 or bucket like $2`, [`%${ips.a}`, `%${PHONE}`]);
    if (hadTestRow) {
      await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(savedTestRow)]);
    } else {
      await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
    }
    await pool.end();
  });

  it('the token: hashed only, valid while on, replaced by a new link, dead when off', async () => {
    const { link, state } = await testMode.issueTestLink(adminId);
    expect(state.enabled).toBe(true);
    expect(link).toMatch(/\/chip-order\?test=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(link);
    const row = (await pool.query<{ value: { tokenHash: string } }>(`select value from public.app_settings where key = 'chip_orders_test_mode'`)).rows[0]!.value;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await testMode.isValidTestToken(token)).toBe(true);
    expect(await testMode.isValidTestToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(await testMode.isValidTestToken('')).toBe(false);
    expect(await testMode.isValidTestToken(null)).toBe(false);

    const second = tokenOf((await testMode.issueTestLink(adminId)).link);
    expect(await testMode.isValidTestToken(token)).toBe(false);
    expect(await testMode.isValidTestToken(second)).toBe(true);

    await testMode.disableTestMode(adminId);
    expect(await testMode.isValidTestToken(second)).toBe(false);
    expect((await testMode.getTestModeState()).enabled).toBe(false);
  });

  it('no token, a wrong token, or a valid token after the switch went off → 403 everywhere', async () => {
    const live = tokenOf((await testMode.issueTestLink(adminId)).link);
    const wrong = `${live.slice(0, -1)}${live.endsWith('A') ? 'B' : 'A'}`;
    for (const token of [undefined, wrong]) {
      expect((await askCode(token)).status).toBe(403);
      expect((await submitOrder(token)).status).toBe(403);
      expect((await finishOrder('x'.repeat(43), token)).status).toBe(403);
    }
    await testMode.disableTestMode(adminId);
    expect((await askCode(live)).status).toBe(403);
    expect((await submitOrder(live)).status).toBe(403);
    expect((await finishOrder('x'.repeat(43), live)).status).toBe(403);
  });

  it('a valid token: the code goes out, the order is is_test, Grow is never called; finish marks it paid once', async () => {
    const token = tokenOf((await testMode.issueTestLink(adminId)).link);
    expect((await askCode(token)).status).toBe(200);

    createPaymentProcess.mockClear();
    const res = await submitOrder(token);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { test?: boolean; trackingToken?: string; total?: number; paymentUrl?: string };
    expect(data.test).toBe(true);
    expect(data.paymentUrl).toBeUndefined();
    expect(data.total).toBe(2 * DEFAULT_CHIP_ORDER_SETTINGS.unitPrice);
    expect(createPaymentProcess).not.toHaveBeenCalled();
    const row = (await pool.query<{ id: string; is_test: boolean; status: string; grow_process_id: string | null }>(
      `select id, is_test, status, grow_process_id from public.chip_orders where tracking_token = $1`, [data.trackingToken],
    )).rows[0]!;
    made.orders.push(row.id);
    expect(row).toMatchObject({ is_test: true, status: 'pending_payment', grow_process_id: null });

    afterQueue.length = 0;
    expect((await finishOrder(data.trackingToken!, token)).status).toBe(200);
    const paid = (await pool.query(`select status, is_test, paid_at, grow_transaction_id, invoice_url from public.chip_orders where id = $1`, [row.id])).rows[0];
    expect(paid).toMatchObject({ status: 'paid', is_test: true, grow_transaction_id: null, invoice_url: null });
    expect(paid.paid_at).not.toBeNull();
    expect(afterQueue).toHaveLength(1);
    // Twice → nothing left to finish.
    expect((await finishOrder(data.trackingToken!, token)).status).toBe(409);
  });

  it('finish never touches an order made without the test link', async () => {
    const token = tokenOf((await testMode.issueTestLink(adminId)).link);
    const real = await db.createChipOrder(
      { fullName: 'הזמנה רגילה', phoneE164: PHONE, email: 'real@example.test', address: 'הרצל 1 חיפה', role: 'owner', ip: null,
        lines: [{ apartmentNumber: APT, chipsCount: 1, lease: null, leaseEndDate: null }] },
      DEFAULT_CHIP_ORDER_SETTINGS,
    );
    made.orders.push(real.id);
    expect((await finishOrder(real.trackingToken, token)).status).toBe(409);
    const r = (await pool.query(`select status, is_test from public.chip_orders where id = $1`, [real.id])).rows[0];
    expect(r).toEqual({ status: 'pending_payment', is_test: false });
    await testMode.disableTestMode(adminId);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// "דלג על אימות (מצב בדיקה)" (13/11/2026), against a throwaway database
// (WA_TEST_DATABASE_URL), never prod. With SMS credit at 0 no code reached
// Ronen's phone, so a test order could not be created at all; a test order may
// now skip the phone code and is stored phone_verified = false.
//   - the skip route: no token / a wrong token / the switch off → 403, and
//     also 403 when the page is open to the public (a real order never skips);
//   - a valid token: the order is is_test + phone_verified=false, no code row
//     is issued or consumed, no provider (019 / Green API) is called;
//   - a real order still needs a verified code: no cookie → 401, and a skip
//     cookie without the token → 401; the database refuses an unverified real
//     order on its own (chip_orders_phone_verified_check).
// The sealed cookies are REAL (setSkippedPhoneCookie / setVerifiedPhoneCookie
// through an in-memory next/headers jar), so the seal, the expiry and the
// separation of the two cookies are what is under test. Grow, the code sender
// and the after() hook are mocked; every row is real.
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

// One browser's cookie jar, shared by every route call below.
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0 || value === '') jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

const h = vi.hoisted(() => ({
  open: false,
  createPaymentProcess: vi.fn(async () => ({ processId: `skip-p-${Date.now()}`, processToken: 't', url: 'https://sandbox.meshulam.co.il/x' })),
  sendPortalCode: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/grow/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/grow/client')>()),
  createPaymentProcess: h.createPaymentProcess,
  isGrowConfigured: () => false,
}));
// "Open to the public" without Grow ids: only chipOrdersOpen is swapped; the
// cookie functions of this module are the real ones.
vi.mock('@/lib/chipOrders/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/chipOrders/server')>()),
  chipOrdersOpen: () => h.open,
}));
vi.mock('@/lib/portal/send', () => ({
  sendPortalCode: h.sendPortalCode,
  alertManagerAboutLockout: vi.fn(async () => undefined),
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: () => undefined,
}));
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder: vi.fn(async () => undefined) }));

const testMode = await import('@/lib/chipOrders/testMode');
const { POST: skip } = await import('@/app/api/public/chip-order/otp/skip/route');
const { POST: submit } = await import('@/app/api/public/chip-order/route');
const { CHIP_ORDER_PHONE_COOKIE, CHIP_ORDER_SKIP_COOKIE, setVerifiedPhoneCookie } = await import('@/lib/chipOrders/server');

const tag = String(Date.now()).slice(-6);
const APT = `995${tag}1`;
const LOCAL = `05394${tag.slice(-5)}`;
const PHONE = `+972${LOCAL.slice(1)}`;
const IP = `198.51.100.${(Date.now() % 200) + 20}`;
const made = { contacts: [] as string[], orders: [] as string[] };
let adminId = '';
let hadTestRow = false;
let savedTestRow: unknown = null;

const tokenOf = (link: string) => new URL(link).searchParams.get('test')!;
const H = (token?: string): Record<string, string> => ({ 'x-real-ip': IP, ...(token ? { 'x-chip-order-test': token } : {}) });

const askSkip = (token?: string, phone = LOCAL) =>
  skip(new Request('http://localhost/api/public/chip-order/otp/skip', {
    method: 'POST',
    headers: { ...H(token), 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  }));

async function submitOrder(token?: string): Promise<Response> {
  const fd = new FormData();
  fd.append('order', JSON.stringify({
    fullName: 'דילוג בודק', phone: LOCAL, email: 'skip.e2e@example.test', address: 'הרצל 2 חיפה',
    role: 'owner', acceptTerms: true, lines: [{ apartment: APT, chipsCount: 1, leaseEndDate: null }],
  }));
  const encoded = new Response(fd);
  const body = Buffer.from(await encoded.arrayBuffer());
  return submit(new Request('http://localhost/api/public/chip-order', {
    method: 'POST',
    headers: { ...H(token), 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) },
    body,
  }));
}

const ordersOfPhone = async () =>
  (await pool.query<{ id: string; is_test: boolean; phone_verified: boolean; status: string }>(
    `select id, is_test, phone_verified, status from public.chip_orders where phone_e164 = $1 order by created_at`, [PHONE],
  )).rows;
const codeRows = async () =>
  (await pool.query<{ n: number }>(`select count(*)::int as n from public.portal_otp_codes where phone_e164 = $1`, [PHONE])).rows[0]!.n;

d('chip orders — "דלג על אימות (מצב בדיקה)"', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    adminId = await requireSeededAdmin(pool);
    const prev = await pool.query(`select value from public.app_settings where key = 'chip_orders_test_mode'`);
    hadTestRow = (prev.rowCount ?? 0) > 0;
    savedTestRow = prev.rows[0]?.value ?? null;
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number) values ($1) returning id`, [APT],
    );
    made.contacts.push(c.rows[0]!.id);
  });

  beforeEach(() => {
    jar.clear();
    h.open = false;
    h.sendPortalCode.mockClear();
    h.createPaymentProcess.mockClear();
    // No provider may be reached from any of these routes.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network call in a skip test'); }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    for (const id of made.orders) await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.query(`delete from public.portal_otp_codes where phone_e164 = $1`, [PHONE]);
    await pool.query(`delete from public.auth_rate_limits where bucket like $1 or bucket like $2`, [`%${IP}`, `%${PHONE}`]);
    if (hadTestRow) {
      await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(savedTestRow)]);
    } else {
      await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
    }
    await pool.end();
  });

  it('skip without a token, with a wrong token, or with test mode off → 403, and no cookie', async () => {
    const live = tokenOf((await testMode.issueTestLink(adminId)).link);
    const wrong = `${live.slice(0, -1)}${live.endsWith('A') ? 'B' : 'A'}`;
    for (const token of [undefined, wrong]) {
      const res = await askSkip(token);
      expect(res.status).toBe(403);
      // No hint that test mode exists — the closed page's own words.
      expect(((await res.json()) as { message: string }).message).toBe('ההזמנות ייפתחו בקרוב.');
    }
    await testMode.disableTestMode(adminId);
    expect((await askSkip(live)).status).toBe(403);
    expect(jar.has(CHIP_ORDER_SKIP_COOKIE)).toBe(false);
  });

  it('the page open to the public: skip without the token is still 403 — a real order never skips', async () => {
    h.open = true;
    const res = await askSkip();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('יש לאמת את מספר הטלפון בקוד לפני התשלום.');
    expect(jar.has(CHIP_ORDER_SKIP_COOKIE)).toBe(false);
  });

  it('a valid token: the order is is_test + phone_verified=false; no code row, no provider call', async () => {
    const token = tokenOf((await testMode.issueTestLink(adminId)).link);
    const codesBefore = await codeRows();

    const s = await askSkip(token);
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ ok: true, skipped: true });
    // Its own sealed cookie — never the verified one — and the phone is not readable in it.
    expect(jar.has(CHIP_ORDER_SKIP_COOKIE)).toBe(true);
    expect(jar.has(CHIP_ORDER_PHONE_COOKIE)).toBe(false);
    expect(jar.get(CHIP_ORDER_SKIP_COOKIE)).not.toContain(PHONE.slice(4));

    const res = await submitOrder(token);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { test?: boolean; paymentUrl?: string };
    expect(data.test).toBe(true);
    expect(data.paymentUrl).toBeUndefined();
    const rows = await ordersOfPhone();
    expect(rows).toHaveLength(1);
    made.orders.push(rows[0]!.id);
    expect(rows[0]).toMatchObject({ is_test: true, phone_verified: false, status: 'pending_payment' });

    expect(await codeRows()).toBe(codesBefore);
    expect(h.sendPortalCode).not.toHaveBeenCalled();
    expect(h.createPaymentProcess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await testMode.disableTestMode(adminId);
  });

  it('the skip cookie is bound to the phone it was made for', async () => {
    const token = tokenOf((await testMode.issueTestLink(adminId)).link);
    expect((await askSkip(token, '0539999999')).status).toBe(200);
    const res = await submitOrder(token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { needsOtp?: boolean }).needsOtp).toBe(true);
    await testMode.disableTestMode(adminId);
  });

  it('a real order still needs a verified code: no cookie → 401, a skip cookie without the token → 401', async () => {
    // A skip cookie made legitimately, then the token is gone (switch off) and
    // the page is open to the public.
    const token = tokenOf((await testMode.issueTestLink(adminId)).link);
    expect((await askSkip(token)).status).toBe(200);
    await testMode.disableTestMode(adminId);
    h.open = true;
    const before = (await ordersOfPhone()).length;

    const withSkipCookie = await submitOrder();
    expect(withSkipCookie.status).toBe(401);
    expect(((await withSkipCookie.json()) as { needsOtp?: boolean }).needsOtp).toBe(true);

    jar.clear();
    const noCookie = await submitOrder();
    expect(noCookie.status).toBe(401);
    expect((await ordersOfPhone()).length).toBe(before);
    expect(h.createPaymentProcess).not.toHaveBeenCalled();
  });

  it('a verified code still makes a real order, stored phone_verified = true (unchanged path)', async () => {
    h.open = true;
    await setVerifiedPhoneCookie(PHONE);
    const res = await submitOrder();
    expect(res.status).toBe(201);
    expect(h.createPaymentProcess).toHaveBeenCalledTimes(1);
    const rows = await ordersOfPhone();
    const real = rows.find((r) => !r.is_test)!;
    made.orders.push(real.id);
    expect(real).toMatchObject({ is_test: false, phone_verified: true, status: 'pending_payment' });
  });

  it('the database refuses an unverified phone on a real order', async () => {
    await expect(pool.query(
      `insert into public.chip_orders (full_name, phone_e164, email, address, role, total, tracking_token, is_test, phone_verified)
       values ('לא תקין', $1, 'x@example.test', 'כתובת', 'owner', 50, $2, false, false)`,
      [PHONE, `skip-check-${tag}-${'x'.repeat(30)}`],
    )).rejects.toMatchObject({ code: '23514', constraint: 'chip_orders_phone_verified_check' });
  });
});

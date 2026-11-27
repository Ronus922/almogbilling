import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Card payment of a chip order through PayPlus (25/11/2026), against a
// throwaway database (WA_TEST_DATABASE_URL), never prod. PayPlus itself is not
// called: its three network functions are stubbed (and fetch refuses anything
// that slips past them); the signature check and the reading of a transaction
// are the real ones, and every row is real.
//
// What must hold (the test link — the sandbox; real orders in production are
// tests/chip-order-live-card-db.test.ts):
//   - a payment session opens only for a TEST order that still waits for
//     payment, always with the sandbox values, with the amount computed on
//     the server;
//   - an order becomes paid only from a callback whose signature is valid, or
//     from the server's own lookup — once, however often it is repeated — and
//     only for a charge that names a payment session THIS server opened for
//     that order (the order number alone pays nothing);
//   - the lookup asks about every recent session of the order, no new session
//     is opened while an earlier one may hold a charge, and an earlier one
//     nothing was charged on is disabled before the next opens;
//   - a sandbox charge never marks a real order paid (route, UPDATE and CHECK);
//   - "סיים הזמנת בדיקה" is closed while the card step is on.
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

// Synthetic key material — never a real PayPlus value.
const SECRET = 'test-secret-key-for-callbacks';
const SANDBOX = { mode: 'sandbox' as const, origin: 'https://restapidev.payplus.co.il', apiKey: 'test-api-key', secretKey: SECRET, pageUid: '11111111-2222-3333-4444-555555555555' };
const PRODUCTION = { mode: 'production' as const, origin: 'https://restapi.payplus.co.il', apiKey: 'test-prod-api-key', secretKey: 'test-prod-secret-key', pageUid: '99999999-8888-7777-6666-555555555555' };
// What payplusConfigFor answers for each environment (null = its values are not set).
let sandboxConfig: typeof SANDBOX | null = SANDBOX;
let productionConfig: typeof PRODUCTION | null = null;
let sessionSeq = 0;
interface SessionInput { amount: number; orderNumber: number; callbackUrl: string; pageOrigin: string }
const createHostedFieldsSession = vi.fn<(cfg: unknown, input: SessionInput) => Promise<{ pageRequestUid: string; hostedFieldsUuid: string }>>(async () => {
  sessionSeq += 1;
  const n = String(sessionSeq).padStart(4, '0');
  return { pageRequestUid: `${RUN}-0000-0000-0000-00000000${n}`, hostedFieldsUuid: `${RUN}-ffff-ffff-ffff-00000000${n}` };
});
type Lookup = { kind: 'transactions'; transactions: unknown[] } | { kind: 'unknown'; status: number; message: string };
const NOTHING: Lookup = { kind: 'transactions', transactions: [] };
const lookupPaymentRequest = vi.fn<(cfg: unknown, uid: string) => Promise<Lookup>>(async () => NOTHING);
const disablePaymentRequest = vi.fn<(cfg: { mode: string }, uid: string) => Promise<boolean>>(async () => true);
// Transactions/View (read only) — what a callback for an order that is
// ALREADY paid makes the server ask (27/11/2026): here, always the charge as
// it is (not cancelled), and no refund of the order.
const viewTransactions = vi.fn(async (_cfg: unknown, by: { transactionUid: string } | { moreInfo: string }) => (
  'transactionUid' in by
    ? { kind: 'transactions' as const, transactions: [{ uid: by.transactionUid, type: 'charge', statusCode: '000', amount: 0, cancelled: false, moreInfo: null }] }
    : { kind: 'transactions' as const, transactions: [] }
));
vi.mock('@/lib/payplus/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/payplus/client')>()),
  payplusConfigFor: (mode: 'sandbox' | 'production') => (mode === 'sandbox' ? sandboxConfig : productionConfig),
  createHostedFieldsSession,
  lookupPaymentRequest,
  disablePaymentRequest,
  viewTransactions,
}));
// Nothing here may reach the network: a PayPlus call that is not one of the
// four stubs above lands here, is recorded, and fails.
const networkCalls: string[] = [];
const PHONE = '+972539400077';
const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(fn); },
}));
const notifyChipOrder = vi.fn<(orderId: string, kind: string) => Promise<undefined>>(async () => undefined);
// What follows an order turning paid. The real one issues the order's Morning
// document first (not here), then sends the "received & paid" message.
const afterOrderPaid = vi.fn(async (orderId: string) => { await notifyChipOrder(orderId, 'paid'); });
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder, afterOrderPaid }));

const RUN = String(Date.now()).slice(-8);
const testMode = await import('@/lib/chipOrders/testMode');
const { POST: sessionRoute } = await import('@/app/api/public/chip-order/payplus/session/route');
const { POST: statusRoute } = await import('@/app/api/public/chip-order/payplus/status/route');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const { POST: finishRoute } = await import('@/app/api/public/chip-order/test-finish/route');
const { POST: submitRoute } = await import('@/app/api/public/chip-order/route');
const orders = await import('@/lib/db/chipOrders');
const { getChipOrderSettings } = await import('@/lib/db/appSettings');

const APT = `994${RUN.slice(-5)}`;
const IP = `203.0.113.${(Date.now() % 200) + 20}`;
const made = { contacts: [] as string[], orders: [] as string[] };
let adminId = '';
let token = '';
let hadTestRow = false;
let savedTestRow: unknown = null;
let hadSettingsRow = false;
let savedSettingsRow: unknown = null;
let unitPrice = 50;

const H = (withToken = true): Record<string, string> => ({
  'x-real-ip': IP, 'content-type': 'application/json', ...(withToken ? { 'x-chip-order-test': token } : {}),
});
const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown, headers = H()) =>
  route(new Request(`http://localhost/api/public/chip-order/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));

interface Made { id: string; number: number; trackingToken: string; total: number }
async function makeOrder(opts: { isTest: boolean; chips?: number }): Promise<Made> {
  const o = await orders.createChipOrder({
    fullName: 'דנה בדיקה', phoneE164: PHONE, email: 'card-test@example.test', address: 'הרצל 1, חיפה 3300000', role: 'owner',
    rows: [{ role: 'owner', fullName: 'דנה בדיקה', apartmentNumber: APT, chipsCount: opts.chips ?? 3, phoneE164: PHONE, email: null, lease: null, leaseEndDate: null }],
    addressParts: { street: 'הרצל 1', city: 'חיפה', zip: '3300000' },
    ip: IP, isTest: opts.isTest, phoneVerified: true,
  }, await getChipOrderSettings());
  made.orders.push(o.id);
  return { id: o.id, number: o.orderNumber, trackingToken: o.trackingToken, total: o.total };
}

interface Row {
  status: string; is_test: boolean; paid_at: string | null; due_at: string | null; card_status: string | null; card_env: string | null;
  card_page_request_uid: string | null; card_transaction_uid: string | null; card_paid_amount: string | null; card_paid_at: string | null;
  card_approval_number: string | null; card_last4: string | null; card_failure_reason: string | null;
}
const rowOf = async (id: string): Promise<Row> =>
  (await pool.query<Row>(`select * from public.chip_orders where id = $1`, [id])).rows[0]!;
const auditCount = async (id: string, action: string): Promise<number> =>
  Number((await pool.query(`select count(*)::int as n from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2`, [id, action])).rows[0].n);
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };

/** A PayPlus transaction notice for an order, as the docs shape it. `session`
 *  = the payment session it went through (payment_request_uid). */
function notice(o: Made, session: string | null, over: { uid?: string; status?: string | number; amount?: number; type?: string | null; description?: string } = {}) {
  return {
    ...(over.type === null ? {} : { transaction_type: over.type ?? 'Charge' }),
    transaction: {
      uid: over.uid ?? `tx-${RUN}-${o.number}`,
      payment_request_uid: session,
      type: 'internal_page',
      status_code: over.status ?? '000',
      ...(over.description ? { status_description: over.description } : {}),
      amount: over.amount ?? o.total,
      currency: 'ILS',
      payments: { number_of_payments: 1 },
      approval_number: '0012345',
      more_info: String(o.number),
    },
    data: { card_information: { four_digits: '9844', expiry_month: '05', expiry_year: '30', card_bin: '532614', identification_number: '000000018' } },
  };
}
const sign = (body: string, key = SECRET) => createHmac('sha256', key).update(body).digest('base64');
function callback(payload: unknown, opts: { hash?: string; userAgent?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', hash: opts.hash ?? sign(body) };
  if (opts.userAgent !== null) headers['user-agent'] = opts.userAgent ?? 'PayPlus';
  return callbackRoute(new Request('http://localhost/api/public/chip-order/payplus/callback', { method: 'POST', headers, body }));
}
const openSession = (o: Made) => post(sessionRoute, 'payplus/session', { trackingToken: o.trackingToken });
/** Opens a session and returns its id. */
async function sessionOf(o: Made): Promise<string> {
  const res = await openSession(o);
  expect(res.status).toBe(200);
  return ((await res.json()) as { page_request_uid: string }).page_request_uid;
}
const askStatus = (o: Made) => post(statusRoute, 'payplus/status', { trackingToken: o.trackingToken });
const allowLookupAgain = (o: Made) => pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-order:card-lookup:order:${o.id}`]);
/** A transaction as the lookup reports it (already read by the client). */
const reported = (o: Made, over: Record<string, unknown> = {}) => ({
  uid: `tx-${RUN}-lk-${o.number}`, pageRequestUid: null, type: 'charge', statusCode: '000', amount: o.total, currency: 'ILS',
  approvalNumber: '7654321', moreInfo: String(o.number), payments: 1, last4: '9844', statusDescription: null, ...over,
});

d('chip orders — card payment (PayPlus hosted fields)', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      networkCalls.push(String(input instanceof Request ? input.url : input));
      throw new TypeError('no network in this test');
    }));
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    adminId = await requireSeededAdmin(pool);
    const prev = await pool.query(`select value from public.app_settings where key = 'chip_orders_test_mode'`);
    hadTestRow = (prev.rowCount ?? 0) > 0;
    savedTestRow = prev.rows[0]?.value ?? null;
    const prevSettings = await pool.query(`select value from public.app_settings where key = 'chip_orders'`);
    hadSettingsRow = (prevSettings.rowCount ?? 0) > 0;
    savedSettingsRow = prevSettings.rows[0]?.value ?? null;
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539400077') returning id`,
      [APT],
    );
    made.contacts.push(c.rows[0]!.id);
    token = new URL((await testMode.issueTestLink(adminId)).link).searchParams.get('test')!;
    unitPrice = (await getChipOrderSettings()).unitPrice;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    for (const id of made.orders) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.auth_rate_limits where bucket like $1`, [`%${id}`]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.query(`delete from public.auth_rate_limits where bucket like $1 or bucket like $2`, [`%${IP}`, `%${PHONE}`]);
    if (hadTestRow) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(savedTestRow)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
    if (hadSettingsRow) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders'`, [JSON.stringify(savedSettingsRow)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders'`);
    await pool.end();
  });

  beforeEach(async () => {
    // Every test opens payment sessions from one address; the hourly ceiling
    // per address belongs to the test that checks it, not to the whole file.
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-order:card-session:ip:${IP}`]);
    sandboxConfig = SANDBOX;
    productionConfig = null;
    afterQueue.length = 0;
    createHostedFieldsSession.mockClear();
    lookupPaymentRequest.mockReset();
    lookupPaymentRequest.mockResolvedValue(NOTHING);
    disablePaymentRequest.mockClear();
    notifyChipOrder.mockClear();
  });

  // ── The session ──────────────────────────────────────────────────────────

  it('no test link, or no sandbox values — the production values never pay a test order → no session and no hint', async () => {
    const o = await makeOrder({ isTest: true });
    expect((await post(sessionRoute, 'payplus/session', { trackingToken: o.trackingToken }, H(false))).status).toBe(403);
    sandboxConfig = null;
    expect((await openSession(o)).status).toBe(403);
    // The production values are set, but a test order pays in the sandbox or not at all.
    productionConfig = PRODUCTION;
    expect((await openSession(o)).status).toBe(403);
    expect((await askStatus(o)).status).toBe(403);
    expect(createHostedFieldsSession).not.toHaveBeenCalled();
    expect((await rowOf(o.id)).card_status).toBeNull();
  });

  it('a REAL order gets no session, even with the test link', async () => {
    const real = await makeOrder({ isTest: false });
    const res = await openSession(real);
    expect(res.status).toBe(409);
    expect(createHostedFieldsSession).not.toHaveBeenCalled();
    const row = await rowOf(real.id);
    expect(row.status).toBe('pending_payment');
    expect(row.card_status).toBeNull();
  });

  it('a test order: the amount is chips × the configured price, whatever the browser sends; the answer is exactly what the SDK needs', async () => {
    const o = await makeOrder({ isTest: true, chips: 3 });
    const res = await post(sessionRoute, 'payplus/session', { trackingToken: o.trackingToken, amount: 1, total: 1, price: 0.01 });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['amount', 'hosted_fields_uuid', 'ok', 'origin', 'page_request_uid']);
    expect(data.origin).toBe('https://restapidev.payplus.co.il');
    expect(data.amount).toBe(3 * unitPrice);
    expect(JSON.stringify(data)).not.toContain(SECRET);
    expect(JSON.stringify(data)).not.toContain(SANDBOX.apiKey);

    expect(createHostedFieldsSession).toHaveBeenCalledTimes(1);
    const input = createHostedFieldsSession.mock.calls[0]![1];
    expect(input.amount).toBe(3 * unitPrice);
    expect(input.amount).toBe(o.total);
    expect(input.orderNumber).toBe(o.number);
    // The callback URL names the environment whose secret validates it.
    expect(input.callbackUrl).toMatch(/\/api\/public\/chip-order\/payplus\/callback\?env=sandbox$/);
    expect(input.callbackUrl).not.toContain(o.trackingToken);

    const row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'pending_payment', card_status: 'started', card_env: 'sandbox', card_page_request_uid: data.page_request_uid });
    // The session is on record with the amount it was opened for.
    const stored = (await pool.query(
      `select order_id, env, amount::float8 as amount from public.chip_order_card_sessions where page_request_uid = $1`, [data.page_request_uid],
    )).rows;
    expect(stored).toEqual([{ order_id: o.id, env: 'sandbox', amount: 3 * unitPrice }]);
  });

  it('refuses when the price of the settings no longer gives the total the order was saved with', async () => {
    const o = await makeOrder({ isTest: true, chips: 2 });
    await pool.query(
      `insert into public.app_settings (key, value) values ('chip_orders', $1::jsonb)
       on conflict (key) do update set value = public.app_settings.value || excluded.value`,
      [JSON.stringify({ unitPrice: unitPrice + 5 })],
    );
    try {
      const res = await openSession(o);
      expect(res.status).toBe(409);
      // The page saves the order again (priced anew) and asks once more.
      expect(await res.json()).toMatchObject({ ok: false, state: 'price_changed' });
      expect(createHostedFieldsSession).not.toHaveBeenCalled();
    } finally {
      await pool.query(`update public.app_settings set value = value || $1::jsonb where key = 'chip_orders'`, [JSON.stringify({ unitPrice })]);
    }
  });

  it('a flat ceiling per order: the 21st session in half an hour is refused', async () => {
    const o = await makeOrder({ isTest: true });
    for (let i = 0; i < 20; i++) expect((await openSession(o)).status).toBe(200);
    expect((await openSession(o)).status).toBe(429);
    expect(createHostedFieldsSession).toHaveBeenCalledTimes(20);
  });

  it('a second session: PayPlus is asked about the first one, which is disabled before another is opened', async () => {
    const o = await makeOrder({ isTest: true });
    const first = await sessionOf(o);
    expect(disablePaymentRequest).not.toHaveBeenCalled(); // nothing to disable before the first
    createHostedFieldsSession.mockClear();
    lookupPaymentRequest.mockClear();

    // Nothing was charged on the first → it is disabled, then a second session is opened, and both are on record.
    const second = await sessionOf(o);
    expect(lookupPaymentRequest.mock.calls.map((c) => c[1])).toEqual([first]);
    expect(disablePaymentRequest.mock.calls.map((c) => [c[0].mode, c[1]])).toEqual([['sandbox', first]]);
    const [asked] = lookupPaymentRequest.mock.invocationCallOrder;
    const [killed] = disablePaymentRequest.mock.invocationCallOrder;
    const [opened] = createHostedFieldsSession.mock.invocationCallOrder;
    expect(asked!).toBeLessThan(killed!);
    expect(killed!).toBeLessThan(opened!);
    expect(second).not.toBe(first);
    const stored = (await pool.query<{ page_request_uid: string }>(`select page_request_uid from public.chip_order_card_sessions where order_id = $1 order by created_at`, [o.id])).rows.map((r) => r.page_request_uid);
    expect(stored).toEqual([first, second]);
    expect((await rowOf(o.id)).card_page_request_uid).toBe(second);

    // PayPlus cannot say what happened on the earlier sessions → no third session,
    // and nothing is disabled (the earlier one may hold a charge).
    createHostedFieldsSession.mockClear();
    disablePaymentRequest.mockClear();
    lookupPaymentRequest.mockResolvedValue({ kind: 'unknown', status: 403, message: 'refused' });
    const blocked = await openSession(o);
    expect(blocked.status).toBe(502);
    expect(createHostedFieldsSession).not.toHaveBeenCalled();
    expect(disablePaymentRequest).not.toHaveBeenCalled();

    // The FIRST session turns out to hold an approved charge (its callback was lost):
    // the order is paid from it, and no further session is opened.
    lookupPaymentRequest.mockImplementation(async (_cfg, uid) => (uid === first ? { kind: 'transactions', transactions: [reported(o)] } : NOTHING));
    const res = await openSession(o);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'paid' });
    expect(createHostedFieldsSession).not.toHaveBeenCalled();
    expect(disablePaymentRequest).not.toHaveBeenCalled();
    await runAfter();
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_page_request_uid: first });
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
  });

  // ── The callback ─────────────────────────────────────────────────────────

  it('a callback with a broken signature, another key, another user-agent or none is refused — and changes nothing', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    const payload = notice(o, session);
    const body = JSON.stringify(payload);
    const good = sign(body);
    const broken = `${good.slice(0, -3)}${good.slice(-3, -1) === 'AA' ? 'BB' : 'AA'}=`;
    expect((await callback(payload, { hash: broken })).status).toBe(401);
    expect((await callback(payload, { hash: sign(body, 'not-our-secret') })).status).toBe(401);
    expect((await callback(payload, { hash: '' })).status).toBe(401);
    expect((await callback(payload, { userAgent: 'Mozilla/5.0' })).status).toBe(401);
    expect((await callback(payload, { userAgent: null })).status).toBe(401);
    // A body altered after it was signed.
    const altered = JSON.stringify({ ...payload, transaction: { ...payload.transaction, more_info: String(o.number + 1) } });
    const res = await callbackRoute(new Request('http://localhost/api/public/chip-order/payplus/callback', {
      method: 'POST', headers: { 'user-agent': 'PayPlus', hash: good, 'content-type': 'application/json' }, body: altered,
    }));
    expect(res.status).toBe(401);
    // A body larger than the route reads.
    const huge = JSON.stringify({ ...payload, padding: 'x'.repeat(70 * 1024) });
    expect((await callbackRoute(new Request('http://localhost/api/public/chip-order/payplus/callback', {
      method: 'POST', headers: { 'user-agent': 'PayPlus', hash: sign(huge), 'content-type': 'application/json' }, body: huge,
    }))).status).toBe(401);
    // The same 401 when PayPlus is not configured at all — the answer is no oracle.
    sandboxConfig = null;
    expect((await callback(payload)).status).toBe(401);
    sandboxConfig = SANDBOX;

    const row = await rowOf(o.id);
    expect(row.status).toBe('pending_payment');
    expect(row.card_status).toBe('started');
    expect(afterQueue).toHaveLength(0);
    expect(notifyChipOrder).not.toHaveBeenCalled();
    expect(await auditCount(o.id, 'paid')).toBe(0);
  });

  it('a valid callback marks the order paid — and the same callback again changes and announces nothing', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    const payload = notice(o, session);

    expect((await callback(payload)).status).toBe(200);
    // The audit row is written WITH the transition — before anything deferred runs.
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    const paid = await rowOf(o.id);
    expect(paid).toMatchObject({
      status: 'paid', card_status: 'paid', card_env: 'sandbox', card_transaction_uid: payload.transaction.uid,
      card_approval_number: '0012345', card_last4: '9844', card_failure_reason: null, card_page_request_uid: session,
    });
    expect(Number(paid.card_paid_amount)).toBe(o.total);
    expect(paid.paid_at).not.toBeNull();
    expect(paid.card_paid_at).not.toBeNull();
    expect(paid.due_at).not.toBeNull();
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(notifyChipOrder).toHaveBeenCalledWith(o.id, 'paid');

    // PayPlus repeats itself: twice more, the same notice.
    for (let i = 0; i < 2; i++) expect((await callback(payload)).status).toBe(200);
    expect(afterQueue).toHaveLength(0);
    const again = await rowOf(o.id);
    expect(again.paid_at).toEqual(paid.paid_at);
    expect(again.card_paid_at).toEqual(paid.card_paid_at);
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(0);

    // Nothing of the card beyond the last four digits was stored anywhere on the order.
    const stored = JSON.stringify(again);
    for (const never of ['532614', '000000018', '05/30']) expect(stored).not.toContain(never);
    const audit = (await pool.query(`select metadata from public.audit_log where entity_id = $1 and action = 'paid'`, [o.id])).rows[0].metadata;
    expect(audit).toMatchObject({ source: 'payplus_callback', provider: 'payplus', env: 'sandbox', transaction_uid: payload.transaction.uid });
    expect(JSON.stringify(audit)).not.toContain('000000018');
  });

  // PayPlus's hosted-fields notice does not say which payment session it went
  // through (seen on the sandbox, 25/11/2026). It is then only a signal.
  it('a valid callback that names NO session makes the server ask PayPlus about the order\'s own sessions — and that answer pays it, once', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    const payload = notice(o, null);
    lookupPaymentRequest.mockClear();
    lookupPaymentRequest.mockImplementation(async (_cfg, uid) => (uid === session ? { kind: 'transactions', transactions: [reported(o, { uid: payload.transaction.uid })] } : NOTHING));

    expect((await callback(payload)).status).toBe(200);
    expect(lookupPaymentRequest.mock.calls.map((c) => c[1])).toEqual([session]);
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_transaction_uid: payload.transaction.uid, card_page_request_uid: session, card_last4: '9844' });
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    const audit = (await pool.query(`select metadata from public.audit_log where entity_id = $1 and action = 'paid'`, [o.id])).rows[0].metadata;
    expect(audit).toMatchObject({ source: 'payplus_lookup', env: 'sandbox', transaction_uid: payload.transaction.uid });

    // The same notice again, and the order page's own check at the same time: nothing more.
    for (let i = 0; i < 2; i++) expect((await callback(payload)).status).toBe(200);
    expect(afterQueue).toHaveLength(0);
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(0);
  });

  it('…and when PayPlus reports nothing on the order\'s sessions, the notice pays nothing (an anomaly, recorded once)', async () => {
    const o = await makeOrder({ isTest: true });
    await sessionOf(o);
    const payload = notice(o, null, { uid: `tx-${RUN}-nosession` });
    for (let i = 0; i < 3; i++) expect((await callback(payload)).status).toBe(200);
    expect((await rowOf(o.id)).status).toBe('pending_payment');
    expect(afterQueue).toHaveLength(0);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(1);
    expect(await auditCount(o.id, 'paid')).toBe(0);
  });

  it('…and when PayPlus cannot be asked right then, the answer is 503 and nothing changed — the notice may come again', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    const payload = notice(o, null);
    lookupPaymentRequest.mockResolvedValue({ kind: 'unknown', status: 0, message: 'no reply' });
    expect((await callback(payload)).status).toBe(503);
    expect((await rowOf(o.id)).status).toBe('pending_payment');
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(0);
    // PayPlus sends it again, and this time it can be asked.
    lookupPaymentRequest.mockImplementation(async (_cfg, uid) => (uid === session ? { kind: 'transactions', transactions: [reported(o, { uid: payload.transaction.uid })] } : NOTHING));
    expect((await callback(payload)).status).toBe(200);
    expect((await rowOf(o.id)).status).toBe('paid');
    expect(afterQueue).toHaveLength(1);
  });

  it('a session-less notice never reaches a real order, an unknown order number, or an order without a session', async () => {
    const real = await makeOrder({ isTest: false });
    const bare = await makeOrder({ isTest: true });
    lookupPaymentRequest.mockClear();
    // Whatever PayPlus would say, it is not even asked: no sandbox session exists for these.
    lookupPaymentRequest.mockResolvedValue({ kind: 'transactions', transactions: [reported(real)] });
    expect((await callback(notice(real, null))).status).toBe(200);
    expect((await callback(notice(bare, null))).status).toBe(200);
    expect((await callback({ ...notice(bare, null), transaction: { ...notice(bare, null).transaction, more_info: '999999999' } })).status).toBe(200);
    expect(lookupPaymentRequest).not.toHaveBeenCalled();
    for (const order of [real, bare]) {
      const row = await rowOf(order.id);
      expect(row.status).toBe('pending_payment');
      expect(row.card_transaction_uid).toBeNull();
    }
    expect(afterQueue).toHaveLength(0);
    expect(notifyChipOrder).not.toHaveBeenCalled();
  });

  it('twenty copies of the callback at the same moment: one transition, one message, one audit row', async () => {
    const o = await makeOrder({ isTest: true });
    const payload = notice(o, await sessionOf(o));
    const answers = await Promise.all(Array.from({ length: 20 }, () => callback(payload)));
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect((await rowOf(o.id)).status).toBe('paid');
  });

  it('the order number alone pays nothing: a charge must name a payment session THIS server opened for THAT order', async () => {
    const o = await makeOrder({ isTest: true });
    const other = await makeOrder({ isTest: true });
    await sessionOf(o);
    const otherSession = await sessionOf(other);
    // No session at all, a session nobody opened, and the session of ANOTHER order —
    // each with the right order number, the right amount and a valid signature.
    expect((await callback(notice(o, null, { uid: `tx-${RUN}-a` }))).status).toBe(200);
    expect((await callback(notice(o, `${RUN}-eeee-eeee-eeee-000000000001`, { uid: `tx-${RUN}-b` }))).status).toBe(200);
    expect((await callback(notice(o, otherSession, { uid: `tx-${RUN}-c` }))).status).toBe(200);
    for (const order of [o, other]) {
      const row = await rowOf(order.id);
      expect(row.status).toBe('pending_payment');
      expect(row.card_transaction_uid).toBeNull();
    }
    expect(afterQueue).toHaveLength(0);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(3);
    // A refusal that names no session of the order does not touch it either.
    expect((await callback(notice(o, otherSession, { uid: `tx-${RUN}-d`, status: '033' }))).status).toBe(200);
    expect((await rowOf(o.id)).card_status).toBe('started');
  });

  it('an order no session was opened for is not paid by a callback', async () => {
    const o = await makeOrder({ isTest: true });
    expect((await callback(notice(o, `${RUN}-eeee-eeee-eeee-000000000002`))).status).toBe(200);
    expect((await rowOf(o.id)).status).toBe('pending_payment');
    expect(afterQueue).toHaveLength(0);
  });

  it('a sandbox charge NEVER marks a real order paid — the route ignores it, and the table refuses it', async () => {
    const real = await makeOrder({ isTest: false });
    expect((await callback(notice(real, `${RUN}-eeee-eeee-eeee-000000000003`))).status).toBe(200);
    await runAfter();
    const row = await rowOf(real.id);
    expect(row.status).toBe('pending_payment');
    expect(row.card_status).toBeNull();
    expect(notifyChipOrder).not.toHaveBeenCalled();
    expect(await auditCount(real.id, 'card_payment_anomaly')).toBe(1);

    // The database itself: sandbox card data cannot be written onto a real order…
    await expect(pool.query(
      `update public.chip_orders set card_provider = 'payplus', card_env = 'sandbox', card_status = 'started',
              card_page_request_uid = $2, card_session_at = now() where id = $1`,
      [real.id, `${RUN}-dead-dead-dead-000000000001`],
    )).rejects.toThrow(/chip_orders_card_env_test_check/);
    // …and a real web order cannot leave pending_payment on a card session
    // nobody confirmed a charge on (since 26/11/2026 it may — but only with
    // card_status 'paid', which chip_orders_card_paid_check ties to a charge).
    await pool.query(
      `update public.chip_orders set card_provider = 'payplus', card_env = 'production', card_status = 'started',
              card_page_request_uid = $2, card_session_at = now() where id = $1`,
      [real.id, `${RUN}-dead-dead-dead-000000000002`],
    );
    await expect(pool.query(`update public.chip_orders set status = 'paid', paid_at = now() where id = $1`, [real.id]))
      .rejects.toThrow(/chip_orders_paid_fields_check/);
    await expect(pool.query(
      `update public.chip_orders set status = 'paid', paid_at = now(), card_status = 'paid', card_transaction_uid = $2 where id = $1`,
      [real.id, `tx-${RUN}-forced`],
    )).rejects.toThrow(/chip_orders_card_paid_check/);
    expect((await rowOf(real.id)).status).toBe('pending_payment');
  });

  it('an approved charge of another amount does not pay the order; it is recorded once', async () => {
    const o = await makeOrder({ isTest: true });
    const payload = notice(o, await sessionOf(o), { amount: o.total - 1 });
    for (let i = 0; i < 2; i++) expect((await callback(payload)).status).toBe(200);
    const row = await rowOf(o.id);
    expect(row.status).toBe('pending_payment');
    expect(row.card_transaction_uid).toBeNull();
    expect(afterQueue).toHaveLength(0);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(1);
  });

  it('status 000 on a notice that does not state its kind is neither paid nor "refused"', async () => {
    const o = await makeOrder({ isTest: true });
    expect((await callback(notice(o, await sessionOf(o), { type: null }))).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'pending_payment', card_status: 'started', card_failure_reason: null });
    expect(afterQueue).toHaveLength(0);
  });

  it('a refused attempt keeps the order waiting with the reason; the approved one after it pays and clears it; a late refusal changes nothing', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    expect((await callback(notice(o, session, { uid: `tx-${RUN}-refused`, status: '033', description: 'declined' }))).status).toBe(200);
    const failed = await rowOf(o.id);
    expect(failed).toMatchObject({ status: 'pending_payment', card_status: 'failed' });
    expect(failed.card_failure_reason).toContain('033');
    expect(failed.card_failure_reason).toContain('declined');
    expect(afterQueue).toHaveLength(0);

    expect((await callback(notice(o, session, { uid: `tx-${RUN}-ok` }))).status).toBe(200);
    await runAfter();
    const paid = await rowOf(o.id);
    expect(paid).toMatchObject({ status: 'paid', card_status: 'paid', card_failure_reason: null, card_transaction_uid: `tx-${RUN}-ok` });

    // The refusal of the earlier attempt arrives again, late.
    expect((await callback(notice(o, session, { uid: `tx-${RUN}-refused`, status: '033', description: 'declined' }))).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_failure_reason: null });
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
  });

  it('a SECOND approved charge on a paid order pays nothing again: one message, one anomaly row', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    expect((await callback(notice(o, session, { uid: `tx-${RUN}-first` }))).status).toBe(200);
    await runAfter();
    for (let i = 0; i < 2; i++) expect((await callback(notice(o, session, { uid: `tx-${RUN}-second` }))).status).toBe(200);
    await runAfter();
    expect((await rowOf(o.id)).card_transaction_uid).toBe(`tx-${RUN}-first`);
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(await auditCount(o.id, 'paid')).toBe(1);
    expect(await auditCount(o.id, 'card_payment_anomaly')).toBe(1);
  });

  it('a callback that is not a charge, or names no order, is acknowledged and ignored', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);
    expect((await callback(notice(o, session, { type: 'Refund' }))).status).toBe(200);
    expect((await callback({ ...notice(o, session), transaction: { ...notice(o, session).transaction, more_info: 'not-a-number' } })).status).toBe(200);
    expect((await callback({ hello: 'world' })).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'pending_payment', card_status: 'started' });
    expect(afterQueue).toHaveLength(0);
  });

  // ── The status (the server-side lookup) ──────────────────────────────────

  it('status: the server asks PayPlus about the order’s own sessions and pays from its answer — once', async () => {
    const o = await makeOrder({ isTest: true });
    const session = await sessionOf(o);

    // PayPlus answered: nothing was charged — and only then does the page hear "not charged".
    let res = await askStatus(o);
    expect(await res.json()).toMatchObject({ ok: true, state: 'pending', charged: 'no' });
    expect(lookupPaymentRequest).toHaveBeenCalledTimes(1);
    expect(lookupPaymentRequest.mock.calls[0]![1]).toBe(session);

    // Asked again at once: the lookup is throttled, so nothing is known about a charge.
    res = await askStatus(o);
    expect(await res.json()).toMatchObject({ state: 'pending', charged: 'unknown' });
    expect(lookupPaymentRequest).toHaveBeenCalledTimes(1);

    // PayPlus does not answer: unknown, never "not charged".
    await allowLookupAgain(o);
    lookupPaymentRequest.mockResolvedValue({ kind: 'unknown', status: 0, message: 'no reply' });
    expect(await (await askStatus(o)).json()).toMatchObject({ state: 'pending', charged: 'unknown' });

    // PayPlus now reports the approved charge.
    await allowLookupAgain(o);
    lookupPaymentRequest.mockResolvedValue({ kind: 'transactions', transactions: [reported(o)] });
    res = await askStatus(o);
    expect(await res.json()).toMatchObject({ ok: true, state: 'paid', orderNumber: o.number });
    expect(await auditCount(o.id, 'paid')).toBe(1);
    await runAfter();
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_transaction_uid: reported(o).uid, card_approval_number: '7654321', card_page_request_uid: session });
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    const audit = (await pool.query(`select metadata from public.audit_log where entity_id = $1 and action = 'paid'`, [o.id])).rows[0].metadata;
    expect(audit).toMatchObject({ source: 'payplus_lookup' });

    // The callback for the same transaction arrives after the lookup: nothing twice.
    expect((await callback(notice(o, session, { uid: reported(o).uid }))).status).toBe(200);
    res = await askStatus(o);
    expect(await res.json()).toMatchObject({ state: 'paid' });
    await runAfter();
    expect(notifyChipOrder).toHaveBeenCalledTimes(1);
    expect(await auditCount(o.id, 'paid')).toBe(1);
  });

  it('status: a charge approved on an EARLIER session of the order is found too', async () => {
    const o = await makeOrder({ isTest: true });
    const first = await sessionOf(o);
    const second = await sessionOf(o);
    await allowLookupAgain(o);
    lookupPaymentRequest.mockClear();
    lookupPaymentRequest.mockImplementation(async (_cfg, uid) => (uid === first ? { kind: 'transactions', transactions: [reported(o)] } : NOTHING));
    expect(await (await askStatus(o)).json()).toMatchObject({ state: 'paid' });
    expect(lookupPaymentRequest.mock.calls.map((c) => c[1])).toEqual([second, first]);
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', card_page_request_uid: first });
  });

  it('status: a transaction of the lookup that names another order, or another amount, pays nothing — and is not "not charged"', async () => {
    const o = await makeOrder({ isTest: true });
    await sessionOf(o);
    lookupPaymentRequest.mockResolvedValue({ kind: 'transactions', transactions: [reported(o, { moreInfo: String(o.number + 100000) })] });
    expect(await (await askStatus(o)).json()).toMatchObject({ state: 'pending', charged: 'unknown' });
    await allowLookupAgain(o);
    lookupPaymentRequest.mockResolvedValue({ kind: 'transactions', transactions: [reported(o, { amount: o.total + 10 })] });
    expect(await (await askStatus(o)).json()).toMatchObject({ state: 'pending', charged: 'unknown' });
    expect((await rowOf(o.id)).status).toBe('pending_payment');
    expect(afterQueue).toHaveLength(0);
    // A refused attempt, and nothing else: PayPlus ruled a charge out.
    await allowLookupAgain(o);
    lookupPaymentRequest.mockResolvedValue({ kind: 'transactions', transactions: [reported(o, { uid: `tx-${RUN}-lk-refused`, statusCode: '033', statusDescription: 'declined' })] });
    expect(await (await askStatus(o)).json()).toMatchObject({ state: 'failed', charged: 'no' });
  });

  it('status: needs the test link, the order’s own token, and a card session of the order', async () => {
    const o = await makeOrder({ isTest: true });
    // Without the test link the question is about a REAL order in production — not configured here.
    expect((await post(statusRoute, 'payplus/status', { trackingToken: o.trackingToken }, H(false))).status).toBe(403);
    // …and when it is, a test order is still not answered there: the order must be of the request's kind.
    productionConfig = PRODUCTION;
    expect((await post(statusRoute, 'payplus/status', { trackingToken: o.trackingToken }, H(false))).status).toBe(409);
    expect((await askStatus(o)).status).toBe(409); // no session was opened for it
    expect((await post(statusRoute, 'payplus/status', { trackingToken: 'x'.repeat(43) })).status).toBe(409);
    expect((await post(statusRoute, 'payplus/status', { trackingToken: 'short' })).status).toBe(400);
    expect(lookupPaymentRequest).not.toHaveBeenCalled();
  });

  // ── The old shortcut ─────────────────────────────────────────────────────

  it('"סיים הזמנת בדיקה" is closed while the card step is on, and works as before without PayPlus', async () => {
    const o = await makeOrder({ isTest: true });
    const res = await post(finishRoute, 'test-finish', { trackingToken: o.trackingToken });
    expect(res.status).toBe(409);
    expect((await rowOf(o.id)).status).toBe('pending_payment');

    sandboxConfig = null;
    expect((await post(finishRoute, 'test-finish', { trackingToken: o.trackingToken })).status).toBe(200);
    await runAfter();
    const row = await rowOf(o.id);
    expect(row.status).toBe('paid');
    expect(row.card_status).toBeNull();
  });

  it('the submit answer says whether the payment step is the card (the sandbox values, for a test order)', async () => {
    const submit = async () => {
      const fd = new FormData();
      fd.append('order', JSON.stringify({
        phone: '0539400077', email: 'card-test@example.test',
        addressStreet: 'הרצל 1', addressCity: 'חיפה', addressZip: '3300000',
        rows: [{ role: 'owner', fullName: 'דנה בדיקה', apartment: APT, chipsCount: 1, phone: '0539400077', email: '', leaseEndDate: null }],
      }));
      const encoded = new Response(fd);
      const body = Buffer.from(await encoded.arrayBuffer());
      const res = await submitRoute(new Request('http://localhost/api/public/chip-order', {
        method: 'POST',
        headers: { 'x-real-ip': IP, 'x-chip-order-test': token, 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) },
        body,
      }));
      expect(res.status).toBe(201);
      const data = (await res.json()) as { cardPayment?: boolean; trackingToken: string; orderNumber: number };
      const id = (await pool.query<{ id: string }>(`select id from public.chip_orders where order_number = $1`, [data.orderNumber])).rows[0]!.id;
      made.orders.push(id);
      return data;
    };
    expect((await submit()).cardPayment).toBe(true);
    // The production values do not give a test order a card step.
    sandboxConfig = null;
    productionConfig = PRODUCTION;
    expect((await submit()).cardPayment).toBe(false);
  });

  it('no request of this file ever left for the network', () => {
    expect(networkCalls).toEqual([]);
  });
});

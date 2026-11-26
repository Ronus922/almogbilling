import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// "אשראי" in the issue window without an order (26/11/2026), against a
// throwaway database (WA_TEST_DATABASE_URL), never prod:
//   - POST /api/chips/reception/card is admins' only; the amount is the new
//     chips × the price of /settings, frozen on a reception order that waits
//     for the payment — never a value of the request;
//   - test: true is the sandbox and a TEST order; a real charge needs live
//     charging armed (PAYPLUS_MODE=production + the PROD values +
//     PAYPLUS_LIVE_CHARGING=on) — and then the production charge queues its
//     Morning invoice row (method card);
//   - the order is paid only by what PayPlus reports (the status route's
//     lookup, the signed callback); the save of the window (POST /api/chips,
//     method 'card') issues the chips onto THAT paid order — exactly those
//     chips, that amount — and ends it collected;
//   - a reception order never messages the customer, also when a card paid it;
//   - "בטל הזמנת קבלה" of a card order refunds it through PayPlus, with its
//     credit row; a paid order whose chips were never issued can be cancelled.
// PayPlus is never called: fetch is a stub that answers by URL path and
// refuses anything else. Rows are removed by the exact ids made here.

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

const fakeEnv: Record<string, string | undefined> = {};
vi.mock('@/env', () => ({ env: fakeEnv }));

const afterQueue: (() => unknown)[] = [];
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => { afterQueue.push(fn); },
}));

const h = vi.hoisted(() => ({
  user: null as null | { id: string; username: string; email: string | null; full_name: string | null; role: string },
}));
vi.mock('@/lib/auth/session', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/session')>()),
  getSession: async () => (h.user ? { sid: 'test', user: h.user } : null),
}));

// The staff bell ("צ׳יפ חדש הונפק", alerts) — recorded here, not written.
const createNotification = vi.fn<(n: { type: string; dedupeKey?: string }) => Promise<undefined>>(async () => undefined);
vi.mock('@/services/notifications', async (orig) => ({
  ...(await orig<typeof import('@/services/notifications')>()),
  createNotification,
}));
// The customer's messages: nothing leaves (the rows notifyChipOrder records are real).
const sendWithRetry = vi.fn<(args: { to: string; subject: string }) => Promise<{ messageId: string; attempts: number }>>(
  async () => ({ messageId: 'test', attempts: 1 }),
);
vi.mock('@/lib/email/send', async (orig) => ({ ...(await orig<typeof import('@/lib/email/send')>()), sendWithRetry }));
vi.mock('@/lib/db/whatsappInstances', async (orig) => ({
  ...(await orig<typeof import('@/lib/db/whatsappInstances')>()),
  getDefaultSendCreds: async () => null,
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN = String(Date.now()).slice(-8);
const tag = RUN.slice(-6);
const PRICE = 35;
const APP_URL = 'https://chips.example.test';
const DEV = { api: 'dev-api-key-reception-test', secret: 'dev-secret-key-reception-test', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-reception-test', secret: 'prod-secret-key-reception-test', page: '99999999-8888-7777-6666-555555555555' };
const ORIGIN = { sandbox: 'https://restapidev.payplus.co.il', production: 'https://restapi.payplus.co.il' } as const;
const APT = { main: `983${tag}1`, other: `983${tag}2` };
const ORDERER = { name: 'משלם באשראי', phone: '0539500073', email: 'reception-card@example.test', street: null, city: null, zip: null };

const { NextRequest } = await import('next/server');
const { POST: cardRoute } = await import('@/app/api/chips/reception/card/route');
const { POST: statusRoute } = await import('@/app/api/chips/reception/card/status/route');
const { POST: chipsRoute } = await import('@/app/api/chips/route');
const { POST: cancelRoute } = await import('@/app/api/chip-orders/[id]/cancel/route');
const { POST: rejectRoute } = await import('@/app/api/chip-orders/[id]/reject/route');
const { POST: refundRoute } = await import('@/app/api/chip-orders/[id]/refund/route');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const { listPendingOrdersWithSessions } = await import('@/lib/db/chipOrderCard');

const made = { contacts: {} as Record<string, string>, users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: string }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
const saved = { hadSettings: false, settings: null as unknown };

// ── PayPlus, as a stub that answers by URL path ─────────────────────────────

interface Sent { origin: string; path: string; apiKey: string | null; secretKey: string | null; body: Record<string, unknown> }
const sent: Sent[] = [];
const elsewhere: string[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Answer = () => Response;
const ipn = new Map<string, Answer>();
const NOT_CHARGED: Answer = () => reply(200, { results: { status: 'error', code: 1, description: 'can-not-find-payment_request_uid' }, data: {} });
/** The lookup's flat reply for an approved charge of the order. */
const charged = (o: { number: number; total: number }, uid: string, tx: string): Answer => () => reply(200, {
  results: { status: 'success', code: 0, description: 'operation has been success' },
  data: {
    transaction_uid: tx, page_request_uid: uid, type: 'Charge', status_code: '000', status_description: 'ok', amount: o.total,
    currency: 'ILS', number_of_payments: 1, approval_num: '0099887', more_info: String(o.number), four_digits: '4580',
    expiry_month: '09', expiry_year: '31', card_bin: '458013', identification_number: '318547290',
  },
});
let generatedSeq = 0;
let refundSeq = 0;
/** PayPlus refuses the next refunds (the card company declined) while true. */
let refundRefused = false;
/** Morning (27/11/2026): "ביטול וזיכוי" issues the credit before it cancels.
 *  A stub that issues every document; what it was sent is kept. */
const MORNING = { token: 'https://api.morning.co/idp/v1/oauth/token', api: 'https://api.greeninvoice.co.il/api/v1' };
const morningDocs: { type: number; emails: unknown }[] = [];
let morningSeq = 0;
function morningAnswer(url: URL, init: RequestInit | undefined, body: Record<string, unknown>): Response | null {
  if (url.href === MORNING.token) return reply(200, { accessToken: 'morning-test-token', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  if (!url.href.startsWith(MORNING.api)) return null;
  const path = url.href.slice(MORNING.api.length);
  if (path === '/businesses/me') return reply(200, { type: 2, exemption: false });
  if (path === '/documents/info?type=320') return reply(200, { exemption: false, vatRate: 0.18 });
  if (path === '/documents/types?lang=he') return reply(200, [{ id: 320 }, { id: 330 }, { id: 400 }]);
  if (path === '/documents/search') return reply(200, { items: [] });
  if (path === '/documents' && init?.method === 'POST') {
    morningSeq += 1;
    morningDocs.push({ type: Number(body.type), emails: (body.client as Record<string, unknown> | undefined)?.emails });
    return reply(200, { id: `${RUN}-0000-4000-8000-${String(morningSeq).padStart(12, '0')}`, number: 60000 + morningSeq, url: { origin: `https://docs.example.test/${morningSeq}` } });
  }
  return reply(404, { errorMessage: `no stub for ${path}` });
}
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  const morning = morningAnswer(url, init, body);
  if (morning) return morning;
  if (url.origin !== ORIGIN.sandbox && url.origin !== ORIGIN.production) {
    elsewhere.push(url.href);
    throw new TypeError(`no network in this test: ${url.href}`);
  }
  sent.push({ origin: url.origin, path: url.pathname, apiKey: headers.get('api-key'), secretKey: headers.get('secret-key'), body });
  if (url.pathname === '/api/v1.0/PaymentPages/generateLink') {
    generatedSeq += 1;
    const n = String(generatedSeq).padStart(12, '0');
    return reply(200, { results: { status: 'success', code: 0 }, data: { page_request_uid: `${RUN}-a2a2-4b2b-8c3c-${n}`, hosted_fields_uuid: `${RUN}-f2f2-4f2f-8f2f-${n}` } });
  }
  if (url.pathname === '/api/v1.0/PaymentPages/ipn') {
    const answer = ipn.get(String(body.payment_request_uid));
    return answer ? answer() : reply(500, { message: 'no answer set for this session in the test' });
  }
  if (url.pathname.startsWith('/api/v1.0/PaymentPages/Disable/')) return reply(200, { results: { status: 'success', code: 0 } });
  // "ביטול וזיכוי" asks first (read only): the charge is there, nothing returned.
  if (url.pathname === '/api/v1.0/Transactions/View') {
    if (typeof body.transaction_uid === 'string') {
      return reply(200, {
        results: { status: 'success', code: 0 },
        data: [{ transaction: { transaction_uid: body.transaction_uid, transaction_type: 'Charge', status_code: '000', transaction_is_cancelled: false, amount: 1 }, data: {} }],
      });
    }
    return reply(200, { results: { status: 'error', code: 1, description: 'no transactions' }, data: {} });
  }
  if (url.pathname === '/api/v1.0/Transactions/RefundByTransactionUID') {
    if (refundRefused) {
      return reply(200, { results: { status: 'error', code: 1, description: 'הזיכוי נדחה על ידי חברת האשראי' }, data: { transaction: { status_code: '004' } } });
    }
    refundSeq += 1;
    return reply(200, {
      results: { status: 'success', code: 0 },
      data: { transaction: { uid: `rf-${RUN}-rc-${refundSeq}`, status_code: '000', amount: body.amount, currency: 'ILS', approval_number: '0123987' } },
    });
  }
  throw new Error(`unexpected PayPlus path in a test: ${url.pathname}`);
});
const callsTo = (path: string) => sent.filter((s) => s.path === `/api/v1.0/${path}`);

// ── Requests ────────────────────────────────────────────────────────────────

const json = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const openCard = (body: Record<string, unknown>) => cardRoute(json('/api/chips/reception/card', body));
const cardBody = (over: Record<string, unknown> = {}) => ({
  contact_id: made.contacts[APT.main], new_chips: 2, test: true, role: 'other', orderer: ORDERER, ...over,
});
const askStatus = (token: string) => statusRoute(json('/api/chips/reception/card/status', { token }));
let chipSeq = 0;
const chipNumbers = (n: number) => Array.from({ length: n }, () => { chipSeq += 1; return `C${tag}${chipSeq}`; });
/** The window's save (POST /api/chips) of `numbers` for one guest, settled by the card order of `token`. */
async function saveByCard(numbers: string[], token: string, opts: { apt?: string; amount?: number } = {}) {
  const res = await chipsRoute(json('/api/chips', {
    contact_id: made.contacts[opts.apt ?? APT.main],
    groups: [{ resident_role: 'other', holder_name: 'אורח באשראי', chip_type: 'physical', numbers, block: 0 }],
    orderer: ORDERER,
    payment: { method: 'card', amount: opts.amount ?? numbers.length * PRICE, card_token: token },
  }));
  // notifyAdminsOfChipIssued runs unawaited after the answer — let it finish.
  await new Promise((r) => setTimeout(r, 30));
  return res;
}
const cancel = (orderId: string, reason: string) => cancelRoute(json(`/api/chip-orders/${orderId}/cancel`, { reason }), { params: Promise.resolve({ id: orderId }) });
const reject = (orderId: string, reason: string) => rejectRoute(json(`/api/chip-orders/${orderId}/reject`, { reason }), { params: Promise.resolve({ id: orderId }) });
const refund = (orderId: string, reason: string) => refundRoute(json(`/api/chip-orders/${orderId}/refund`, { reason }), { params: Promise.resolve({ id: orderId }) });
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');
function callback(payload: unknown, env: 'sandbox' | 'production') {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request(`http://localhost/api/public/chip-order/payplus/callback?env=${env}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body, env === 'sandbox' ? DEV.secret : PROD.secret) },
    body,
  }));
}
const allowLookupAgain = (orderId: string) => pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-lookup:order:${orderId}`]);

// ── Reading rows ────────────────────────────────────────────────────────────

interface OrderRow {
  id: string; order_number: number; source: string; status: string; is_test: boolean; payment_method: string | null; total: number;
  full_name: string; email: string | null; card_status: string | null; card_env: string | null; card_page_request_uid: string | null;
  card_transaction_uid: string | null; card_paid_amount: number | null; card_last4: string | null; paid_at: Date | null; due_at: Date | null;
  collected_at: Date | null; payment_recorded_by: string | null; payment_recorded_by_name: string | null; cancelled_by: string | null;
  refund_via: string | null; refund_status: string | null; refunded_at: Date | null; refunded_amount: number | null;
}
const byToken = async (token: string): Promise<OrderRow> => (await pool.query<OrderRow>(
  `select id, order_number, source, status, is_test, payment_method, total::float8 as total, full_name, email, card_status, card_env,
          card_page_request_uid, card_transaction_uid, card_paid_amount::float8 as card_paid_amount, card_last4, paid_at, due_at,
          collected_at, payment_recorded_by, payment_recorded_by_name, cancelled_by, refund_via, refund_status, refunded_at,
          refunded_amount::float8 as refunded_amount
     from public.chip_orders where tracking_token = $1`, [token],
)).rows[0]!;
const itemsOf = async (orderId: string) => (await pool.query(
  `select contact_id, apartment_number, chips_count, unit_price::float8 as unit_price, line_total::float8 as line_total from public.chip_order_items where order_id = $1`, [orderId],
)).rows;
const holdersOf = async (orderId: string) => (await pool.query(`select full_name, chips_count, source from public.chip_order_holders where order_id = $1`, [orderId])).rows;
const chipsOf = async (orderId: string) => (await pool.query<{ chip_number: string; status: string; order_holder_id: string | null }>(
  `select c.chip_number, c.status, c.order_holder_id from public.chips c join public.chip_order_items i on i.id = c.order_item_id
    where i.order_id = $1 order by c.chip_number`, [orderId],
)).rows;
const chipsByNumber = async (numbers: string[]) => Number((await pool.query(`select count(*)::int as n from public.chips where chip_number = any($1::text[])`, [numbers])).rows[0].n);
const docsOf = async (orderId: string) => (await pool.query<{ id: string; kind: string; payment_key: string; credit_of: string | null; amount: number; payment_method: string; status: string }>(
  `select id, kind, payment_key, credit_of, amount::float8 as amount, payment_method, status from public.chip_order_documents where order_id = $1 order by created_at`, [orderId],
)).rows;
const messagesOf = async (orderId: string) => Number((await pool.query(`select count(*)::int as n from public.chip_order_notifications where order_id = $1`, [orderId])).rows[0].n);
const auditActions = async (orderId: string) => (await pool.query<{ action: string; metadata: Record<string, unknown> }>(
  `select action, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 order by created_at, action`, [orderId],
)).rows;
const ordersOfContact = async (apt: string) => Number((await pool.query(
  `select count(*)::int as n from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = $1`, [made.contacts[apt]],
)).rows[0].n);
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };

interface Opened { token: string; order_number: number; amount: number; test: boolean; session: { page_request_uid: string; hosted_fields_uuid: string; origin: string; amount: number } }
async function opened(body: Record<string, unknown>): Promise<Opened> {
  const res = await openCard(body);
  expect(res.status).toBe(200);
  return (await res.json()) as Opened;
}
/** A reception card order paid in the sandbox through the status route's lookup. */
async function paidTestOrder(chips: number): Promise<{ o: Opened; row: OrderRow; tx: string }> {
  const o = await opened(cardBody({ new_chips: chips }));
  const row = await byToken(o.token);
  const tx = `tx-${RUN}-rc-${row.order_number}`;
  ipn.set(o.session.page_request_uid, charged({ number: row.order_number, total: row.total }, o.session.page_request_uid, tx));
  await allowLookupAgain(row.id);
  expect(await (await askStatus(o.token)).json()).toMatchObject({ ok: true, state: 'paid' });
  return { o, row: await byToken(o.token), tx };
}

d('"אשראי" at the reception — the card order, its payment, the save onto it, and its cancellation', () => {
  const orderIds = new Set<string>();
  const track = (id: string) => { orderIds.add(id); return id; };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    const username = `rcard-mgr-${tag}`;
    const m = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', 'מנהל קבלה', 'manager', true) returning id`,
      [username, `${username}@example.test`],
    );
    made.users.push(m.rows[0]!.id);
    users.manager = { id: m.rows[0]!.id, username, email: null, full_name: 'מנהל קבלה', role: 'manager' };
    // The manager may issue chips and record cash — every chips permission of the matrix.
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager.id, mod]);
    }
    for (const apt of Object.values(APT)) {
      made.contacts[apt] = (await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539500073') returning id`, [apt],
      )).rows[0]!.id;
    }
    const s = await pool.query(`select value from public.app_settings where key = 'chip_orders'`);
    saved.hadSettings = (s.rowCount ?? 0) > 0;
    saved.settings = s.rows[0]?.value ?? null;
    await pool.query(
      `insert into public.app_settings (key, value) values ('chip_orders', $1::jsonb)
       on conflict (key) do update set value = public.app_settings.value || excluded.value`,
      [JSON.stringify({ unitPrice: PRICE })],
    );
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-session:user:${seeded}`]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    for (const id of (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`, [contactIds],
    )).rows.map((r) => r.id)) orderIds.add(id);
    const ids = [...orderIds];
    const chipIds = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows.map((r) => r.id);
    for (const id of chipIds) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    const docIds = (await pool.query<{ id: string }>(`select id from public.chip_order_documents where order_id = any($1::uuid[])`, [ids])).rows.map((r) => r.id);
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1 and credit_of is not null`, [id]);
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1`, [id]);
    for (const id of ids) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-lookup:order:${id}`]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.users) {
      await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
      await pool.query(`delete from public.users where id = $1`, [id]);
    }
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-session:user:${users.super!.id}`]);
    if (saved.hadSettings) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders'`, [JSON.stringify(saved.settings)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders'`);
    await pool.end();
  });

  beforeEach(() => {
    for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
    // Production mode with both key sets; the live switch unset (its default) — real charges are OFF.
    Object.assign(fakeEnv, {
      APP_URL,
      PAYPLUS_MODE: 'production',
      PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page,
      PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page,
    });
    sent.length = 0;
    ipn.clear();
    refundRefused = false;
    afterQueue.length = 0;
    createNotification.mockClear();
    sendWithRetry.mockClear();
    as('super');
  });

  // ── Who may open a card payment, and when ────────────────────────────────

  it('admins only: a manager with every chips permission gets 403, nobody signed in 401 — no order, no PayPlus call', async () => {
    for (const [key, status] of [['manager', 403], [null, 401]] as const) {
      as(key);
      expect((await openCard(cardBody())).status, String(key)).toBe(status);
    }
    expect(await ordersOfContact(APT.main)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a REAL charge while live charging is off → 403; the sandbox test mode without its values → 403 — nothing is created', async () => {
    expect((await openCard(cardBody({ test: false }))).status).toBe(403); // PAYPLUS_LIVE_CHARGING unset
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'off';
    expect((await openCard(cardBody({ test: false }))).status).toBe(403);
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    fakeEnv.PAYPLUS_MODE = 'sandbox'; // the switch alone arms nothing
    expect((await openCard(cardBody({ test: false }))).status).toBe(403);
    fakeEnv.PAYPLUS_MODE = 'production';
    delete fakeEnv.PAYPLUS_DEV_SECRET_KEY;
    expect((await openCard(cardBody({ test: true }))).status).toBe(403);
    expect(await ordersOfContact(APT.main)).toBe(0);
    expect(sent).toEqual([]);
  });

  // ── The test mode, end to end ────────────────────────────────────────────

  let first: { o: Opened; row: OrderRow };
  /** Every session the first order had, oldest first. */
  const firstSessions: string[] = [];

  it('test: true → a TEST reception order waiting for the card: the amount is chips × the price of /settings (never the request), and a sandbox session is opened for exactly that', async () => {
    const o = await opened(cardBody({ new_chips: 2, amount: 1, total: 1, price: 0.01 }));
    expect(o).toMatchObject({ test: true, amount: 2 * PRICE, session: { origin: ORIGIN.sandbox, amount: 2 * PRICE } });
    expect(o.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await byToken(o.token);
    track(row.id);
    expect(row).toMatchObject({
      order_number: o.order_number, source: 'reception', status: 'pending_payment', is_test: true, payment_method: 'card', total: 2 * PRICE,
      full_name: ORDERER.name, email: ORDERER.email, card_status: 'started', card_env: 'sandbox',
      card_page_request_uid: o.session.page_request_uid, payment_recorded_by: users.super!.id, payment_recorded_by_name: 'e2e-admin',
      paid_at: null, collected_at: null,
    });
    expect(await itemsOf(row.id)).toEqual([{ contact_id: made.contacts[APT.main], apartment_number: APT.main, chips_count: 2, unit_price: PRICE, line_total: 2 * PRICE }]);
    expect(await holdersOf(row.id)).toEqual([]);
    expect((await pool.query(`select env, amount::float8 as amount from public.chip_order_card_sessions where page_request_uid = $1`, [o.session.page_request_uid])).rows)
      .toEqual([{ env: 'sandbox', amount: 2 * PRICE }]);

    const [gen] = callsTo('PaymentPages/generateLink');
    expect(callsTo('PaymentPages/generateLink')).toHaveLength(1);
    expect(gen).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api, secretKey: DEV.secret });
    expect(gen!.body).toMatchObject({
      payment_page_uid: DEV.page, amount: 2 * PRICE, more_info: String(row.order_number), initial_invoice: false,
      refURL_callback: `${APP_URL}/api/public/chip-order/payplus/callback?env=sandbox`, refURL_origin: APP_URL,
      customer: { customer_name: ORDERER.name, email: ORDERER.email },
    });
    expect((await auditActions(row.id)).map((a) => a.action)).toEqual(['card_payment_started']);
    for (const secret of [DEV.api, DEV.secret, PROD.api, PROD.secret]) expect(JSON.stringify(o)).not.toContain(secret);
    first = { o, row };
    firstSessions.push(o.session.page_request_uid);
  });

  it('the window renews its session with the token: only after PayPlus said nothing was charged — the earlier one is disabled first', async () => {
    const before = first.o.session.page_request_uid;
    ipn.set(before, NOT_CHARGED);
    const again = await opened(cardBody({ new_chips: 2, token: first.o.token }));
    expect(again).toMatchObject({ token: first.o.token, order_number: first.o.order_number, amount: 2 * PRICE });
    expect(again.session.page_request_uid).not.toBe(before);
    expect(sent.map((s) => s.path)).toEqual(['/api/v1.0/PaymentPages/ipn', `/api/v1.0/PaymentPages/Disable/${before}`, '/api/v1.0/PaymentPages/generateLink']);
    // Other chips than the order's: not this order any more.
    const res = await openCard(cardBody({ new_chips: 3, token: first.o.token }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: 'stale' });
    first = { o: again, row: await byToken(first.o.token) };
    firstSessions.push(again.session.page_request_uid);
  });

  it('the status route asks PayPlus and applies an approved charge it reports → paid, with no due date (the chips are handed over now)', async () => {
    const [older, uid] = firstSessions as [string, string];
    expect(uid).toBe(first.o.session.page_request_uid);
    // Every recent session of the order is asked about; "not charged" only when PayPlus answered for each.
    ipn.set(uid, NOT_CHARGED);
    await allowLookupAgain(first.row.id);
    expect(await (await askStatus(first.o.token)).json()).toEqual({ ok: true, state: 'pending', charged: 'unknown', looked: true });
    ipn.set(older, NOT_CHARGED);
    await allowLookupAgain(first.row.id);
    expect(await (await askStatus(first.o.token)).json()).toEqual({ ok: true, state: 'pending', charged: 'no', looked: true });
    expect(callsTo('PaymentPages/ipn').map((s) => s.body.payment_request_uid)).toEqual([uid, older, uid, older]);

    await allowLookupAgain(first.row.id);
    const tx = `tx-${RUN}-rc-first`;
    ipn.set(uid, charged({ number: first.row.order_number, total: first.row.total }, uid, tx));
    expect(await (await askStatus(first.o.token)).json()).toEqual({ ok: true, state: 'paid', amount: 2 * PRICE, order_number: first.row.order_number, order_id: first.row.id });
    const row = await byToken(first.o.token);
    expect(row).toMatchObject({
      status: 'paid', card_status: 'paid', card_env: 'sandbox', card_transaction_uid: tx, card_paid_amount: 2 * PRICE, card_last4: '4580',
      due_at: null, card_page_request_uid: uid,
    });
    expect(row.paid_at).not.toBeNull();
    // A test order: never a Morning document.
    expect(await docsOf(row.id)).toEqual([]);
    await runAfter();
    // Asked again: the database answers, PayPlus is not asked.
    sent.length = 0;
    await allowLookupAgain(row.id);
    expect(await (await askStatus(first.o.token)).json()).toMatchObject({ ok: true, state: 'paid' });
    expect(sent).toEqual([]);
    first = { o: first.o, row };
  });

  it('a manager (not an admin) saving with method "card" → 403, nothing saved', async () => {
    as('manager');
    const numbers = chipNumbers(2);
    const res = await saveByCard(numbers, first.o.token);
    expect(res.status).toBe(403);
    expect(await chipsByNumber(numbers)).toBe(0);
    expect((await byToken(first.o.token)).status).toBe('paid');
  });

  it('a TEST card payment never issues chips: the save → 400 test_card_payment — nothing saved, the test order stays paid with no holders', async () => {
    const numbers = chipNumbers(2);
    const res = await saveByCard(numbers, first.o.token);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'test_card_payment' });
    expect(await chipsByNumber(numbers)).toBe(0);
    expect(await byToken(first.o.token)).toMatchObject({ status: 'paid', collected_at: null, is_test: true });
    expect(await holdersOf(first.row.id)).toEqual([]);
  });

  it('a save naming an order the card did not pay (waiting or unknown) → 409 card_not_paid', async () => {
    const waiting = await opened(cardBody({ new_chips: 1 }));
    track((await byToken(waiting.token)).id);
    for (const token of [waiting.token, 'x'.repeat(43)]) {
      const numbers = chipNumbers(1);
      const res = await saveByCard(numbers, token);
      expect(res.status, token.slice(0, 6)).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'card_not_paid' });
      expect(await chipsByNumber(numbers)).toBe(0);
    }
    expect((await byToken(waiting.token)).status).toBe('pending_payment');
    // An order that was never paid cannot be cancelled either.
    expect((await cancel((await byToken(waiting.token)).id, 'לא שולם')).status).toBe(409);
  });

  it('a card order PAID whose chips were never issued (the window was closed) can be cancelled: refunded in the sandbox, nothing to disable, no document', async () => {
    const { row, tx } = await paidTestOrder(1);
    track(row.id);
    sent.length = 0;
    const res = await cancel(row.id, 'החלון נסגר לפני ההנפקה');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, failed_step: null, chips_disabled: 0, refund: 'refunded', credit_numbers: [], credit_email: null,
    });
    // PayPlus is asked first (read only), in the sandbox.
    expect(callsTo('Transactions/View').every((c) => c.origin === ORIGIN.sandbox)).toBe(true);
    expect(callsTo('Transactions/View').length).toBeGreaterThan(0);
    expect(callsTo('Transactions/RefundByTransactionUID')).toHaveLength(1);
    expect(callsTo('Transactions/RefundByTransactionUID')[0]).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api });
    expect(callsTo('Transactions/RefundByTransactionUID')[0]!.body).toEqual({ transaction_uid: tx, amount: PRICE, more_info: `refund:${row.order_number}`, initial_invoice: false });
    expect(await byToken((await pool.query(`select tracking_token as t from public.chip_orders where id = $1`, [row.id])).rows[0].t)).toMatchObject({
      status: 'rejected', cancelled_by: users.super!.id, refund_via: 'reception_cancel', refund_status: 'refunded', refunded_amount: PRICE,
    });
    expect(await docsOf(row.id)).toEqual([]);
    expect(await messagesOf(row.id)).toBe(0);
  });

  // Regression (review, 26/11): "דחה" is a manager permission and refunds no
  // reception order — it must never close one (only "בטל הזמנת קבלה", admins
  // only, which refunds the card with it).
  it('"דחה" never closes a reception order — also one a card PAID whose chips were never issued: 409 for a manager and an admin, the order unchanged, no refund call; "זיכוי" refuses it too until it is cancelled', async () => {
    const { row } = await paidTestOrder(1);
    track(row.id);
    sent.length = 0;
    afterQueue.length = 0; // what followed the payment itself
    for (const key of ['manager', 'super'] as const) {
      as(key);
      const res = await reject(row.id, 'ניסיון דחייה');
      expect(res.status, key).toBe(409);
      expect((await res.json()).error).toContain('ביטול וזיכוי');
    }
    as('super');
    const refused = await refund(row.id, 'ניסיון זיכוי');
    expect(refused.status).toBe(409);
    const token = (await pool.query(`select tracking_token as t from public.chip_orders where id = $1`, [row.id])).rows[0].t as string;
    expect(await byToken(token)).toMatchObject({ status: 'paid', card_status: 'paid', refund_status: null, refunded_at: null, cancelled_by: null });
    expect(callsTo('Transactions/RefundByTransactionUID')).toEqual([]);
    expect(afterQueue).toHaveLength(0);
  });

  // Regression (review, 26/11): a desk charge whose callback was lost and whose
  // window was closed is found by the hourly sweep — newest session first, so
  // the same abandoned orders never take every run's places.
  it('the hourly reconcile sweep takes RECEPTION card orders waiting for the card too — newest session first', async () => {
    const older = await opened(cardBody({ new_chips: 1 }));
    const newer = await opened(cardBody({ new_chips: 1 }));
    const a = track((await byToken(older.token)).id);
    const b = track((await byToken(newer.token)).id);
    for (const [id, minutes] of [[a, 30], [b, 20]] as const) {
      await pool.query(`update public.chip_order_card_sessions set created_at = now() - make_interval(mins => $2) where order_id = $1`, [id, minutes]);
      await pool.query(`update public.chip_orders set card_session_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);
    }
    const ids = (await listPendingOrdersWithSessions('sandbox', 10, 48 * 60, 1000)).map((o) => o.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });

  // ── Real charges ─────────────────────────────────────────────────────────

  let live: { o: Opened; row: OrderRow; tx: string; numbers: string[] };

  it('LIVE (production + the PROD values + the switch on): a REAL reception order, a production session; its charge (the signed callback) queues an invoice row with method card — and messages nobody', async () => {
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    const o = await opened(cardBody({ new_chips: 3, test: false }));
    expect(o).toMatchObject({ test: false, amount: 3 * PRICE, session: { origin: ORIGIN.production, amount: 3 * PRICE } });
    let row = await byToken(o.token);
    track(row.id);
    expect(row).toMatchObject({ is_test: false, source: 'reception', status: 'pending_payment', card_env: 'production', payment_method: 'card', total: 3 * PRICE });
    expect(callsTo('PaymentPages/generateLink')[0]).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api, secretKey: PROD.secret });
    expect(callsTo('PaymentPages/generateLink')[0]!.body).toMatchObject({
      payment_page_uid: PROD.page, amount: 3 * PRICE, refURL_callback: `${APP_URL}/api/public/chip-order/payplus/callback?env=production`,
    });

    const tx = `tx-${RUN}-rc-live`;
    const notice = {
      transaction_type: 'Charge',
      transaction: {
        uid: tx, payment_request_uid: o.session.page_request_uid, type: 'internal_page', status_code: '000', amount: 3 * PRICE, currency: 'ILS',
        payments: { number_of_payments: 1 }, approval_number: '0012345', more_info: String(row.order_number),
      },
      data: { card_information: { four_digits: '4580' } },
    };
    expect((await callback(notice, 'production')).status).toBe(200);
    expect((await callback(notice, 'production')).status).toBe(200);
    row = await byToken(o.token);
    expect(row).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'production', card_transaction_uid: tx, due_at: null });
    const docs = await docsOf(row.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'invoice', payment_key: `card:${tx}`, amount: 3 * PRICE, payment_method: 'card', status: 'pending' });
    // What follows a paid order runs — and a reception order sends no message.
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(await messagesOf(row.id)).toBe(0);
    expect(sendWithRetry).not.toHaveBeenCalled();

    // Another number of chips, or another apartment, than the card paid → 409, nothing saved.
    let wrong = chipNumbers(2);
    let res = await saveByCard(wrong, o.token, { amount: 3 * PRICE });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'card_amount_mismatch' });
    expect(await chipsByNumber(wrong)).toBe(0);
    wrong = chipNumbers(3);
    res = await saveByCard(wrong, o.token, { apt: APT.other, amount: 3 * PRICE });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'card_amount_mismatch' });
    expect(await chipsByNumber(wrong)).toBe(0);
    expect(await ordersOfContact(APT.other)).toBe(0);
    expect(await holdersOf(row.id)).toEqual([]);

    // The save issues the chips onto THAT order and ends it collected.
    const numbers = chipNumbers(3);
    res = await saveByCard(numbers, o.token, { amount: 3 * PRICE });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.order).toEqual({ id: row.id, order_number: row.order_number, total: 3 * PRICE, method: 'card' });
    expect(data.record).toBeNull();
    row = await byToken(o.token);
    expect(row).toMatchObject({ status: 'collected', source: 'reception', payment_method: 'card', card_status: 'paid' });
    expect(row.collected_at).not.toBeNull();
    expect(await holdersOf(row.id)).toEqual([{ full_name: 'אורח באשראי', chips_count: 3, source: 'reception' }]);
    const chips = await chipsOf(row.id);
    expect(chips.map((c) => [c.chip_number, c.status])).toEqual([...numbers].sort().map((n) => [n, 'active']));
    const trail = await auditActions(row.id);
    expect(trail.map((a) => a.action)).toEqual(expect.arrayContaining(['card_payment_started', 'created', 'payment_recorded']));
    expect(trail.find((a) => a.action === 'payment_recorded')!.metadata).toMatchObject({ method: 'card', amount: 3 * PRICE, order_number: row.order_number });
    // The same card payment again: already used.
    const again = chipNumbers(3);
    res = await saveByCard(again, o.token, { amount: 3 * PRICE });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'card_not_paid' });
    expect(await chipsByNumber(again)).toBe(0);
    await runAfter();
    expect(await messagesOf(row.id)).toBe(0);
    live = { o, row, tx, numbers };
  });

  it('"ביטול וזיכוי" of that paid card order: refunded through PayPlus (production), its invoice and the credit issued in Morning to the orderer\'s email, then its chips disabled; nobody messaged', async () => {
    fakeEnv.MORNING_API_KEY_ID = 'morning-test-id';
    fakeEnv.MORNING_API_KEY_SECRET = 'morning-test-secret';
    morningDocs.length = 0;
    // What PayPlus says of the session (read first): the charge, nothing returned.
    ipn.set(live.o.session.page_request_uid, charged({ number: live.row.order_number, total: live.row.total }, live.o.session.page_request_uid, live.tx));
    const [invoice] = await docsOf(live.row.id);
    const res = await cancel(live.row.id, 'החזרת התשלום בקבלה');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, chips_disabled: 3, refund: 'refunded', credit_email: { status: 'sent', to: ORDERER.email } });
    // The invoice (still waiting — no key until now) first, then 330 + 400, every one to the orderer.
    expect(morningDocs).toEqual([{ type: 320, emails: [ORDERER.email] }, { type: 330, emails: [ORDERER.email] }, { type: 400, emails: [ORDERER.email] }]);
    const refunds = callsTo('Transactions/RefundByTransactionUID');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api, secretKey: PROD.secret });
    expect(refunds[0]!.body).toEqual({ transaction_uid: live.tx, amount: 3 * PRICE, more_info: `refund:${live.row.order_number}`, initial_invoice: false });

    const row = await byToken(live.o.token);
    expect(row).toMatchObject({
      status: 'rejected', cancelled_by: users.super!.id, refund_via: 'reception_cancel', refund_status: 'refunded', refunded_amount: 3 * PRICE,
    });
    expect(row.refunded_at).not.toBeNull();
    expect((await chipsOf(row.id)).map((c) => c.status)).toEqual(['inactive', 'inactive', 'inactive']);
    const docs = await docsOf(row.id);
    expect(docs).toHaveLength(2);
    expect(docs[1]).toMatchObject({
      kind: 'credit', payment_key: `refund:rf-${RUN}-rc-${refundSeq}`, credit_of: invoice!.id, amount: 3 * PRICE, payment_method: 'card', status: 'issued',
    });
    // A card is credited by its refund — never by a "cancel:" credit as well.
    expect(docs.some((x) => x.payment_key === `cancel:${row.id}`)).toBe(false);
    await runAfter();
    expect(await messagesOf(row.id)).toBe(0);
    // Cancelled once.
    expect((await cancel(live.row.id, 'שוב')).status).toBe(409);
    expect(callsTo('Transactions/RefundByTransactionUID')).toHaveLength(1);
  });

  // 27/11/2026: the refund comes FIRST — a refund PayPlus refuses stops
  // "ביטול וזיכוי" there, the order not cancelled; the retry runs what is left.
  it('a REAL reception card order whose refund PayPlus REFUSES: "ביטול וזיכוי" stops at the refund (nothing cancelled, no credit); the retry refunds it, credits it in Morning and cancels it — two refund calls, never a third', async () => {
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    fakeEnv.MORNING_API_KEY_ID = 'morning-test-id';
    fakeEnv.MORNING_API_KEY_SECRET = 'morning-test-secret';
    const o = await opened(cardBody({ new_chips: 1, test: false }));
    let row = await byToken(o.token);
    track(row.id);
    const tx = `tx-${RUN}-rc-refused`;
    expect((await callback({
      transaction_type: 'Charge',
      transaction: {
        uid: tx, payment_request_uid: o.session.page_request_uid, type: 'internal_page', status_code: '000', amount: PRICE, currency: 'ILS',
        payments: { number_of_payments: 1 }, approval_number: '0012388', more_info: String(row.order_number),
      },
      data: { card_information: { four_digits: '4580' } },
    }, 'production')).status).toBe(200);
    await runAfter();
    const [invoice] = await docsOf(row.id);
    expect(invoice).toMatchObject({ kind: 'invoice', payment_key: `card:${tx}` });
    ipn.set(o.session.page_request_uid, charged({ number: row.order_number, total: row.total }, o.session.page_request_uid, tx));

    // Paid, chips never issued — PayPlus refuses the refund.
    refundRefused = true;
    let res = await cancel(row.id, 'ביטול בקבלה');
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund', refund: 'none' });
    expect(body.message).toContain('PayPlus סירב לזיכוי');
    row = await byToken(o.token);
    expect(row).toMatchObject({ status: 'paid', refund_status: 'manual_required', refunded_at: null, cancelled_by: null });
    expect(await docsOf(row.id)).toHaveLength(1);

    // The retry — no reason needed again — refunds, credits and cancels.
    refundRefused = false;
    as('manager');
    expect((await cancelRoute(json(`/api/chip-orders/${row.id}/cancel`, {}), { params: Promise.resolve({ id: row.id }) })).status).toBe(403);
    as('super');
    res = await cancelRoute(json(`/api/chip-orders/${row.id}/cancel`, {}), { params: Promise.resolve({ id: row.id }) });
    body = await res.json();
    expect(body).toMatchObject({ ok: true, refund: 'refunded', chips_disabled: 0 });
    const refunds = callsTo('Transactions/RefundByTransactionUID');
    expect(refunds).toHaveLength(2);
    expect(refunds[1]!.body).toEqual({ transaction_uid: tx, amount: PRICE, more_info: `refund:${row.order_number}`, initial_invoice: false });
    row = await byToken(o.token);
    expect(row).toMatchObject({ status: 'rejected', refund_via: 'reception_cancel', refund_status: 'refunded', refunded_amount: PRICE, cancelled_by: users.super!.id });
    const docs = await docsOf(row.id);
    expect(docs).toHaveLength(2);
    expect(docs[1]).toMatchObject({ kind: 'credit', payment_key: `refund:rf-${RUN}-rc-${refundSeq}`, credit_of: invoice!.id, amount: PRICE, status: 'issued' });
    await runAfter();
    expect(await messagesOf(row.id)).toBe(0);
    // Done once.
    expect((await cancel(row.id, 'שוב')).status).toBe(409);
    expect(callsTo('Transactions/RefundByTransactionUID')).toHaveLength(2);
  });

  // Regression (25/11 night run): the price of /settings changed between the
  // card payment and the save — the paid chips must still be issued (the save
  // is checked against what the card paid, not against today's price).
  it('a price changed in /settings after the card paid does not strand the chips: the save settles the PAID amount', async () => {
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    const o = await opened(cardBody({ new_chips: 2, test: false }));
    const row = await byToken(o.token);
    track(row.id);
    const tx = `tx-${RUN}-rc-price`;
    const notice = {
      transaction_type: 'Charge',
      transaction: {
        uid: tx, payment_request_uid: o.session.page_request_uid, type: 'internal_page', status_code: '000', amount: 2 * PRICE, currency: 'ILS',
        payments: { number_of_payments: 1 }, approval_number: '0012399', more_info: String(row.order_number),
      },
      data: { card_information: { four_digits: '4580' } },
    };
    expect((await callback(notice, 'production')).status).toBe(200);
    await runAfter();
    await pool.query(`update public.app_settings set value = value || $1::jsonb where key = 'chip_orders'`, [JSON.stringify({ unitPrice: PRICE + 15 })]);
    try {
      const numbers = chipNumbers(2);
      const res = await saveByCard(numbers, o.token, { amount: 2 * PRICE });
      expect(res.status).toBe(201);
      expect((await res.json()).order).toEqual({ id: row.id, order_number: row.order_number, total: 2 * PRICE, method: 'card' });
      expect((await chipsOf(row.id)).map((c) => c.status)).toEqual(['active', 'active']);
      await runAfter();
    } finally {
      await pool.query(`update public.app_settings set value = value || $1::jsonb where key = 'chip_orders'`, [JSON.stringify({ unitPrice: PRICE })]);
    }
  });

  it('no request of this file ever left for anywhere but the PayPlus stub', () => {
    expect(elsewhere).toEqual([]);
  });
});

import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Phase A of "payments end to end" (26/11/2026), against a throwaway database
// (WA_TEST_DATABASE_URL), never prod:
//   - real charging is ARMED only by PAYPLUS_MODE=production + the three PROD
//     values + PAYPLUS_LIVE_CHARGING=on (off by default), and the public page
//     takes orders only while the /settings switch is on as well;
//   - the order form saves its order with no phone code (phone_verified NULL)
//     and saves it AGAIN with its tracking token before the payment — only
//     while it waits, is of the request's kind, and nothing was charged on it;
//   - a real order pays in PRODUCTION, a test order always in the sandbox, and
//     a session nothing was charged on is disabled before another opens;
//   - the callback validates with the secret of the environment its URL names
//     (?env=), or — without one — with each configured secret in turn;
//   - the hourly run looks an unpaid order up in PayPlus over EVERY session it
//     had before deleting it, and reconciles orders whose session is 10
//     minutes to 48 hours old;
//   - no card data reaches the log.
// PayPlus is never called: fetch is a stub that answers by URL path
// (generateLink, ipn, Disable) and refuses anything else. The client, the
// signature check, the configuration rules and every row are the real ones.
// Key values are synthetic. Rows are removed by the exact ids made here.
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
const notifyChipOrder = vi.fn<(orderId: string, kind: string) => Promise<undefined>>(async () => undefined);
// What follows an order turning paid. The real one issues the order's Morning
// document first (not here), then sends the "received & paid" message.
const afterOrderPaid = vi.fn(async (orderId: string) => { await notifyChipOrder(orderId, 'paid'); });
vi.mock('@/lib/chipOrders/notify', () => ({ notifyChipOrder, afterOrderPaid }));

/** Every best-effort lease removal (the files no row keeps any more). */
const removedLeases: string[][] = [];
const uploadChipOrderLease = vi.fn(async (bytes: Buffer, name: string) => (
  { objectKey: `${crypto.randomUUID()}.${name.split('.').pop()}`, sizeBytes: bytes.byteLength }
));
vi.mock('@/lib/storage/chipOrderLeaseStorage', () => ({
  uploadChipOrderLease,
  removeChipOrderLeases: vi.fn(async (keys: string[]) => { removedLeases.push([...keys]); }),
  removeChipOrderLeasesStrict: vi.fn(async () => true),
}));

const testMode = await import('@/lib/chipOrders/testMode');
const { POST: submitRoute } = await import('@/app/api/public/chip-order/route');
const { POST: sessionRoute } = await import('@/app/api/public/chip-order/payplus/session/route');
const { POST: statusRoute } = await import('@/app/api/public/chip-order/payplus/status/route');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const orders = await import('@/lib/db/chipOrders');
const { listRecentCardSessions, setCardSession } = await import('@/lib/db/chipOrderCard');
const { purgeUnpaidChipOrders, reconcilePendingCardOrders } = await import('@/lib/chipOrders/cleanup');
const { getChipOrderSettings } = await import('@/lib/db/appSettings');
const { logger } = await import('@/lib/logger');

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN = String(Date.now()).slice(-8);
const APP_URL = 'https://chips.example.test';
const DEV = { api: 'dev-api-key-live-test-01', secret: 'dev-secret-key-live-test-01', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-live-test-01', secret: 'prod-secret-key-live-test-01', page: '99999999-8888-7777-6666-555555555555' };
const ORIGIN = { sandbox: 'https://restapidev.payplus.co.il', production: 'https://restapi.payplus.co.il' } as const;
const PRICE = 40;
const IP = `198.51.100.${(Date.now() % 200) + 30}`;
const PHONE_LOCAL = '0539600071';
const PHONE = '+972539600071';
const APT1 = `996${RUN.slice(-5)}1`;
const APT2 = `996${RUN.slice(-5)}2`;
/** What a PayPlus payload carries about the card — distinctive values, so any
 *  of them reaching a log line would show. */
const CARD = { four: '7391', month: '09', year: '31', bin: '458013', id: '318547290', holder: 'Holder Distinct' };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

const made = { contacts: [] as string[], orders: [] as string[], notifications: [] as string[] };
const updateBuckets = new Set<string>();
let adminId = '';
let token = '';
const saved = { settings: null as unknown, hadSettings: false, testMode: null as unknown, hadTestMode: false };

/** Neither armed nor open: production mode with both key sets, the live switch unset (its default). */
function resetEnv() {
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  Object.assign(fakeEnv, {
    APP_URL,
    PAYPLUS_MODE: 'production',
    PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page,
    PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page,
  });
}
async function setSettings(patch: Record<string, unknown>) {
  await pool.query(
    `insert into public.app_settings (key, value) values ('chip_orders', $1::jsonb)
     on conflict (key) do update set value = public.app_settings.value || excluded.value`,
    [JSON.stringify(patch)],
  );
}
/** Real charging armed AND the page switch on. */
async function armLive() {
  fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
  await setSettings({ ordersOpen: true });
}

// ── PayPlus, as a stub that answers by URL path ─────────────────────────────

interface Sent { origin: string; path: string; apiKey: string | null; secretKey: string | null; body: Record<string, unknown> }
const sent: Sent[] = [];
type Answer = () => Response;
/** What PaymentPages/ipn answers, per payment session. Unset → HTTP 500 ("unknown"). */
const ipn = new Map<string, Answer>();
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOT_CHARGED: Answer = () => reply(200, { results: { status: 'error', code: 1, description: 'can-not-find-payment_request_uid' }, data: {} });
const UNREACHABLE: Answer = () => { throw new TypeError('fetch failed'); };
/** The lookup's reply (flat, as the sandbox gave it) for an approved charge —
 *  with the card fields PayPlus puts next to it. */
const charged = (o: { number: number; total: number }, uid: string, over: Record<string, unknown> = {}): Answer => () => reply(200, {
  results: { status: 'success', code: 0, description: 'operation has been success' },
  data: {
    transaction_uid: `tx-${RUN}-lk-${o.number}`, page_request_uid: uid, type: 'Charge', status_code: '000', status_description: 'ok',
    amount: o.total, currency: 'ILS', number_of_payments: 1, approval_num: '0099887', more_info: String(o.number),
    four_digits: CARD.four, expiry_month: CARD.month, expiry_year: CARD.year, identification_number: CARD.id,
    card_bin: CARD.bin, card_holder_name: CARD.holder, ...over,
  },
});
/** What Transactions/View answers for a transaction uid (decision 3.4,
 *  27/11/2026: a charge is read again here before an order is marked paid).
 *  Unset → the charge as PayPlus shows it right after it went through:
 *  approved, not cancelled. */
const view = new Map<string, Answer>();
/** …and for a more_info (the order's refunds). Unset → none. */
const viewByMoreInfo = new Map<string, Answer>();
const NO_TRANSACTIONS: Answer = () => reply(200, { results: { status: 'error', code: 1, description: 'no transactions' }, data: {} });
const viewed = (uid: string, o: { number: number; total: number }, over: Record<string, unknown> = {}): Answer => () => reply(200, {
  results: { status: 'success', code: 0, description: 'operation has been success' },
  data: [{ transaction: {
    transaction_uid: uid, transaction_type: 'Charge', status_code: '000', transaction_is_cancelled: false,
    amount: o.total, more_info: String(o.number), ...over,
  } }],
});
let generatedSeq = 0;
const generatedUid = (n: number) => `${RUN}-a1a1-4b2b-8c3c-${String(n).padStart(12, '0')}`;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  sent.push({ origin: url.origin, path: url.pathname, apiKey: headers.get('api-key'), secretKey: headers.get('secret-key'), body });
  if (url.origin !== ORIGIN.sandbox && url.origin !== ORIGIN.production) throw new Error(`a request left for ${url.origin} in a test`);
  if (url.pathname === '/api/v1.0/PaymentPages/generateLink') {
    generatedSeq += 1;
    return reply(200, {
      results: { status: 'success', code: 0 },
      data: { page_request_uid: generatedUid(generatedSeq), hosted_fields_uuid: `${RUN}-ffff-4fff-8fff-${String(generatedSeq).padStart(12, '0')}` },
    });
  }
  if (url.pathname === '/api/v1.0/PaymentPages/ipn') {
    const answer = ipn.get(String(body.payment_request_uid));
    return answer ? answer() : reply(500, { message: 'no answer set for this session in the test' });
  }
  if (url.pathname.startsWith('/api/v1.0/PaymentPages/Disable/')) return reply(200, { results: { status: 'success', code: 0 } });
  if (url.pathname === '/api/v1.0/Transactions/View') {
    if (typeof body.transaction_uid === 'string') {
      const answer = view.get(body.transaction_uid);
      return answer ? answer() : viewed(body.transaction_uid, { number: 0, total: 1 }, { more_info: null })();
    }
    const answer = viewByMoreInfo.get(String(body.more_info));
    return answer ? answer() : NO_TRANSACTIONS();
  }
  throw new Error(`unexpected PayPlus path in a test: ${url.pathname}`);
});
const ipnAsked = () => sent.filter((s) => s.path === '/api/v1.0/PaymentPages/ipn').map((s) => String(s.body.payment_request_uid));
const askedAbout = (uid: string) => sent.find((s) => s.path === '/api/v1.0/PaymentPages/ipn' && s.body.payment_request_uid === uid);
const disabled = () => sent.filter((s) => s.path.startsWith('/api/v1.0/PaymentPages/Disable/')).map((s) => decodeURIComponent(s.path.split('/').pop()!));
const generated = () => sent.filter((s) => s.path === '/api/v1.0/PaymentPages/generateLink');

// ── The logger, watched ─────────────────────────────────────────────────────

const logged: unknown[][] = [];
const spies: { mockRestore(): void }[] = [];

// ── Requests ────────────────────────────────────────────────────────────────

const headersOf = (test: boolean, extra: Record<string, string> = {}): Record<string, string> => ({
  'x-real-ip': IP, ...(test ? { 'x-chip-order-test': token } : {}), ...extra,
});

interface RowIn { chipsCount: number; role?: 'owner' | 'tenant'; fullName?: string; apartment?: string; lease?: boolean; leaseFile?: File; leaseKey?: string }
/** POST /api/public/chip-order — multipart, as the page sends it. */
async function save(rows: RowIn[], opts: { test: boolean; trackingToken?: string; extra?: Record<string, unknown> }): Promise<Response> {
  const fd = new FormData();
  fd.append('order', JSON.stringify({
    phone: PHONE_LOCAL, email: 'live-card@example.test', acceptTerms: true,
    addressStreet: 'הרצל 1', addressCity: 'חיפה', addressZip: '3300000',
    ...(opts.trackingToken ? { trackingToken: opts.trackingToken } : {}),
    rows: rows.map((r) => ({
      role: r.role ?? 'owner', fullName: r.fullName ?? 'דנה בדיקה', apartment: r.apartment ?? APT1, chipsCount: r.chipsCount,
      phone: PHONE_LOCAL, email: '', leaseEndDate: r.role === 'tenant' ? '2030-12-31' : null,
      ...(r.leaseKey ? { leaseKey: r.leaseKey } : {}),
    })),
    ...opts.extra,
  }));
  rows.forEach((r, i) => { if (r.lease) fd.append(`lease_${i}`, r.leaseFile ?? new File([PDF], `lease-${i}.pdf`, { type: 'application/pdf' })); });
  if (opts.trackingToken) updateBuckets.add(`chip-order:update:order:${createHash('sha256').update(opts.trackingToken).digest('hex').slice(0, 24)}`);
  const encoded = new Response(fd);
  const body = Buffer.from(await encoded.arrayBuffer());
  return submitRoute(new Request('http://localhost/api/public/chip-order', {
    method: 'POST',
    headers: headersOf(opts.test, { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) }),
    body,
  }));
}
interface Saved { ok: boolean; test: boolean; orderNumber: number; total: number; trackingToken: string; cardPayment: boolean; leaseKeys: (string | null)[]; id: string }
/** A 201 of a new order — its id goes on the list of rows to remove. */
async function createdFrom(res: Response): Promise<Saved> {
  expect(res.status).toBe(201);
  const data = (await res.json()) as Omit<Saved, 'id'>;
  const id = (await pool.query<{ id: string }>(`select id from public.chip_orders where order_number = $1`, [data.orderNumber])).rows[0]!.id;
  made.orders.push(id);
  return { ...data, id };
}

interface Made { id: string; number: number; trackingToken: string; total: number }
/** An order straight on the DB (the form's own path is tested on its own). */
async function makeOrder(opts: { isTest: boolean; chips?: number }): Promise<Made> {
  const o = await orders.createChipOrder({
    termsAccepted: true,
    fullName: 'דנה בדיקה', phoneE164: PHONE, email: 'live-card@example.test', address: 'הרצל 1, חיפה 3300000', role: 'owner',
    rows: [{ role: 'owner', fullName: 'דנה בדיקה', apartmentNumber: APT1, chipsCount: opts.chips ?? 2, phoneE164: PHONE, email: null, lease: null, leaseEndDate: null }],
    addressParts: { street: 'הרצל 1', city: 'חיפה', zip: '3300000' },
    ip: IP, isTest: opts.isTest,
  }, await getChipOrderSettings());
  made.orders.push(o.id);
  return { id: o.id, number: o.orderNumber, trackingToken: o.trackingToken, total: o.total };
}
const asMade = (s: Saved): Made => ({ id: s.id, number: s.orderNumber, trackingToken: s.trackingToken, total: s.total });

const openSession = (o: { trackingToken: string }, test: boolean) =>
  sessionRoute(new Request('http://localhost/api/public/chip-order/payplus/session', {
    method: 'POST', headers: headersOf(test, { 'content-type': 'application/json' }), body: JSON.stringify({ trackingToken: o.trackingToken }),
  }));
async function sessionOf(o: { trackingToken: string }, test: boolean): Promise<string> {
  const res = await openSession(o, test);
  expect(res.status).toBe(200);
  return ((await res.json()) as { page_request_uid: string }).page_request_uid;
}
const askStatus = (o: { trackingToken: string }, test: boolean) =>
  statusRoute(new Request('http://localhost/api/public/chip-order/payplus/status', {
    method: 'POST', headers: headersOf(test, { 'content-type': 'application/json' }), body: JSON.stringify({ trackingToken: o.trackingToken }),
  }));

const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');
/** A notice as PayPlus sends it to the callback URL — `env` is its ?env=. */
function callback(payload: unknown, opts: { key: string; env?: string }) {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request(`http://localhost/api/public/chip-order/payplus/callback${opts.env ? `?env=${opts.env}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body, opts.key) }, body,
  }));
}
let noticeSeq = 0;
/** PayPlus's transaction notice (the callback's nested shape) — with the card data it carries. */
function notice(o: Made, session: string | null, over: { amount?: number } = {}) {
  noticeSeq += 1;
  return {
    transaction_type: 'Charge',
    transaction: {
      uid: `tx-${RUN}-${o.number}-${noticeSeq}`, payment_request_uid: session, type: 'internal_page', status_code: '000',
      amount: over.amount ?? o.total, currency: 'ILS', payments: { number_of_payments: 1 }, approval_number: '0012345', more_info: String(o.number),
    },
    data: {
      card_information: {
        card_holder_name: CARD.holder, four_digits: CARD.four, expiry_month: CARD.month, expiry_year: CARD.year,
        card_bin: CARD.bin, identification_number: CARD.id,
      },
    },
  };
}

// ── Reading rows ────────────────────────────────────────────────────────────

interface OrderRow {
  id: string; status: string; source: string; is_test: boolean; phone_verified: boolean | null; total: number; full_name: string;
  card_status: string | null; card_env: string | null; card_page_request_uid: string | null; card_transaction_uid: string | null;
  card_last4: string | null; internal_note: string | null; orderer_note: string | null;
}
const rowOf = async (id: string): Promise<OrderRow> => (await pool.query<OrderRow>(
  `select id, status, source, is_test, phone_verified, total::float8 as total, full_name, card_status, card_env,
          card_page_request_uid, card_transaction_uid, card_last4, internal_note, orderer_note
     from public.chip_orders where id = $1`, [id],
)).rows[0]!;
const exists = async (id: string) => ((await pool.query(`select 1 from public.chip_orders where id = $1`, [id])).rowCount ?? 0) > 0;
const holdersOf = async (id: string) => (await pool.query(
  `select h.full_name, h.chips_count, h.role, h.lease_file_key, i.apartment_number
     from public.chip_order_holders h join public.chip_order_items i on i.id = h.item_id
    where h.order_id = $1 order by h.position`, [id],
)).rows;
const itemsOf = async (id: string) => (await pool.query(
  `select apartment_number, chips_count, unit_price::float8 as unit_price, line_total::float8 as line_total
     from public.chip_order_items where order_id = $1 order by apartment_number`, [id],
)).rows;
const sessionsOf = async (id: string) => (await pool.query(
  `select page_request_uid, env, amount::float8 as amount from public.chip_order_card_sessions where order_id = $1 order by created_at`, [id],
)).rows;
const auditCount = async (id: string, action: string) => Number((await pool.query(
  `select count(*)::int as n from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2`, [id, action],
)).rows[0].n);
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };

let ownSeq = 0;
/** A payment session of the order opened `minutesAgo` (straight on the DB). */
async function withSession(o: Made, env: 'sandbox' | 'production', minutesAgo: number): Promise<string> {
  ownSeq += 1;
  const uid = `${RUN}-dddd-4ddd-8ddd-${String(ownSeq).padStart(12, '0')}`;
  expect(await setCardSession(o.id, { env, pageRequestUid: uid, amount: o.total })).toBe(true);
  await pool.query(`update public.chip_order_card_sessions set created_at = now() - make_interval(mins => $2) where page_request_uid = $1`, [uid, minutesAgo]);
  await pool.query(`update public.chip_orders set card_session_at = now() - make_interval(mins => $2) where id = $1`, [o.id, minutesAgo]);
  return uid;
}
const makeStale = (o: Made) => pool.query(`update public.chip_orders set created_at = now() - interval '49 hours' where id = $1`, [o.id]);

const ignoreMissingTable = (e: { code?: string }) => { if (e.code !== '42P01') throw e; };

d('chip orders — real card payment in production, the form without a phone code, and the hourly lookups', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      spies.push(vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { logged.push([level, ...args]); }));
    }
    spies.push(vi.spyOn(logger, 'child').mockImplementation(() => logger));
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    adminId = await requireSeededAdmin(pool);
    const s = await pool.query(`select value from public.app_settings where key = 'chip_orders'`);
    saved.hadSettings = (s.rowCount ?? 0) > 0;
    saved.settings = s.rows[0]?.value ?? null;
    const t = await pool.query(`select value from public.app_settings where key = 'chip_orders_test_mode'`);
    saved.hadTestMode = (t.rowCount ?? 0) > 0;
    saved.testMode = t.rows[0]?.value ?? null;
    for (const apt of [APT1, APT2]) {
      const c = await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', $2) returning id`,
        [apt, PHONE_LOCAL],
      );
      made.contacts.push(c.rows[0]!.id);
    }
    token = new URL((await testMode.issueTestLink(adminId)).link).searchParams.get('test')!;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const spy of spies) spy.mockRestore();
    if (!pool) return;
    for (const id of made.orders) {
      // A document row (Morning, 26/11/2026) blocks deleting its order — credits first, then the rest.
      await pool.query(`delete from public.chip_order_documents where order_id = $1 and credit_of is not null`, [id]).catch(ignoreMissingTable);
      await pool.query(`delete from public.chip_order_documents where order_id = $1`, [id]).catch(ignoreMissingTable);
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.auth_rate_limits where bucket = any($1::text[])`, [[`chip-order:card-session:order:${id}`, `chip-order:card-lookup:order:${id}`]]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.notifications) await pool.query(`delete from public.notifications where id = $1`, [id]);
    await pool.query(`delete from public.auth_rate_limits where bucket = any($1::text[])`, [[
      ...updateBuckets, `chip-order:save:ip:${IP}`, `chip-order:submit:ip:${IP}`, `chip-order:submit:phone:${PHONE}`,
      `chip-order:card-session:ip:${IP}`, `chip-order:card-status:ip:${IP}`,
    ]]);
    if (saved.hadSettings) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders'`, [JSON.stringify(saved.settings)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders'`);
    if (saved.hadTestMode) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders_test_mode'`, [JSON.stringify(saved.testMode)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders_test_mode'`);
    await pool.end();
  });

  beforeEach(async () => {
    resetEnv();
    await setSettings({ unitPrice: PRICE, ordersOpen: false });
    // The flat ceilings per network and per phone belong to the tests that check them.
    await pool.query(`delete from public.auth_rate_limits where bucket = any($1::text[])`, [[
      `chip-order:save:ip:${IP}`, `chip-order:submit:ip:${IP}`, `chip-order:submit:phone:${PHONE}`,
      `chip-order:card-session:ip:${IP}`, `chip-order:card-status:ip:${IP}`,
    ]]);
    sent.length = 0;
    ipn.clear();
    view.clear();
    viewByMoreInfo.clear();
    afterQueue.length = 0;
    removedLeases.length = 0;
    logged.length = 0;
    uploadChipOrderLease.mockClear();
    notifyChipOrder.mockClear();
    afterOrderPaid.mockClear();
  });

  // ── The switch ───────────────────────────────────────────────────────────

  it('the production switch is OFF by default: production mode, every PROD value and the page switch on still leave the page closed to residents (403) — only PAYPLUS_LIVE_CHARGING=on opens it', async () => {
    const before = Number((await pool.query(`select count(*)::int as n from public.chip_orders where phone_e164 = $1`, [PHONE])).rows[0].n);
    await setSettings({ ordersOpen: true });
    expect((await save([{ chipsCount: 1 }], { test: false })).status).toBe(403); // PAYPLUS_LIVE_CHARGING unset
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'off';
    expect((await save([{ chipsCount: 1 }], { test: false })).status).toBe(403);
    // The live switch, but the page's own switch off.
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    await setSettings({ ordersOpen: false });
    expect((await save([{ chipsCount: 1 }], { test: false })).status).toBe(403);
    // The live switch and the page switch, but not production mode / a PROD value missing.
    await setSettings({ ordersOpen: true });
    fakeEnv.PAYPLUS_MODE = 'sandbox';
    expect((await save([{ chipsCount: 1 }], { test: false })).status).toBe(403);
    fakeEnv.PAYPLUS_MODE = 'production';
    delete fakeEnv.PAYPLUS_PROD_PAGE_UID;
    expect((await save([{ chipsCount: 1 }], { test: false })).status).toBe(403);
    expect(Number((await pool.query(`select count(*)::int as n from public.chip_orders where phone_e164 = $1`, [PHONE])).rows[0].n)).toBe(before);

    // Everything armed: a REAL order, saved with no phone code.
    fakeEnv.PAYPLUS_PROD_PAGE_UID = PROD.page;
    const real = await createdFrom(await save([{ chipsCount: 2 }], { test: false }));
    expect(real).toMatchObject({ ok: true, test: false, total: 2 * PRICE, cardPayment: true });
    expect(await rowOf(real.id)).toMatchObject({ is_test: false, source: 'web', status: 'pending_payment', phone_verified: null, total: 2 * PRICE });
    expect(sent).toEqual([]); // saving an order never talks to PayPlus
  });

  // ── The form: save, and save again ───────────────────────────────────────

  it('a new order with the test link: 201 with no phone code — phone_verified NULL, priced on the server', async () => {
    const t = await createdFrom(await save([{ chipsCount: 3 }], { test: true, extra: { total: 1, price: 0.01 } }));
    expect(t).toMatchObject({ ok: true, test: true, total: 3 * PRICE, cardPayment: true, leaseKeys: [null] });
    expect(t.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await rowOf(t.id)).toMatchObject({ is_test: true, source: 'web', status: 'pending_payment', phone_verified: null, total: 3 * PRICE });
    // Without the sandbox values the payment step of a test order is not the card ("סיים הזמנת בדיקה").
    delete fakeEnv.PAYPLUS_DEV_SECRET_KEY;
    const bare = await createdFrom(await save([{ chipsCount: 1 }], { test: true }));
    expect(bare.cardPayment).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a save with the tracking token REPLACES the content of the same order — priced again from the settings, its people written anew', async () => {
    const first = await createdFrom(await save([{ chipsCount: 2 }], { test: true }));
    await setSettings({ unitPrice: PRICE + 5 });
    const res = await save(
      [{ chipsCount: 3, fullName: 'יוסי חדש' }, { chipsCount: 1, fullName: 'רונית שנייה', apartment: APT2 }],
      { test: true, trackingToken: first.trackingToken, extra: { note: 'הערה חדשה' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, test: true, orderNumber: first.orderNumber, total: 4 * (PRICE + 5), trackingToken: first.trackingToken,
      cardPayment: true, leaseKeys: [null, null],
    });
    expect(await rowOf(first.id)).toMatchObject({ status: 'pending_payment', total: 4 * (PRICE + 5), full_name: 'יוסי חדש', orderer_note: 'הערה חדשה', internal_note: null, phone_verified: null });
    expect(await holdersOf(first.id)).toEqual([
      { full_name: 'יוסי חדש', chips_count: 3, role: 'owner', lease_file_key: null, apartment_number: APT1 },
      { full_name: 'רונית שנייה', chips_count: 1, role: 'owner', lease_file_key: null, apartment_number: APT2 },
    ]);
    expect(await itemsOf(first.id)).toEqual([
      { apartment_number: APT1, chips_count: 3, unit_price: PRICE + 5, line_total: 3 * (PRICE + 5) },
      { apartment_number: APT2, chips_count: 1, unit_price: PRICE + 5, line_total: PRICE + 5 },
    ]);
    // Still ONE order behind the token; no session yet, so PayPlus was not asked.
    expect(Number((await pool.query(`select count(*)::int as n from public.chip_orders where tracking_token = $1`, [first.trackingToken])).rows[0].n)).toBe(1);
    expect(sent).toEqual([]);
  });

  it('an order that is paid, or of the other kind, or unknown, is not edited (409) — and nothing changes', async () => {
    // Paid.
    const paid = await createdFrom(await save([{ chipsCount: 2 }], { test: true }));
    expect(await orders.markTestChipOrderPaid(paid.trackingToken)).toBe(paid.id);
    let res = await save([{ chipsCount: 5 }], { test: true, trackingToken: paid.trackingToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'paid' });
    expect(await rowOf(paid.id)).toMatchObject({ status: 'paid', total: 2 * PRICE });

    // A REAL order's token with the test link, and a TEST order's token without it.
    await armLive();
    const real = await createdFrom(await save([{ chipsCount: 1 }], { test: false }));
    const test = await createdFrom(await save([{ chipsCount: 1 }], { test: true }));
    res = await save([{ chipsCount: 4 }], { test: true, trackingToken: real.trackingToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'not_pending' });
    res = await save([{ chipsCount: 4 }], { test: false, trackingToken: test.trackingToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'not_pending' });
    // A token no order has.
    res = await save([{ chipsCount: 4 }], { test: true, trackingToken: 'x'.repeat(43) });
    expect(res.status).toBe(409);
    for (const o of [real, test]) {
      expect(await rowOf(o.id)).toMatchObject({ status: 'pending_payment', total: PRICE });
      expect(await holdersOf(o.id)).toHaveLength(1);
    }
    expect(sent).toEqual([]);
  });

  it('a renter row keeps its lease by key; a key of ANOTHER order is refused (400 lease_missing); a lease no row keeps goes to the remover after the answer', async () => {
    const a = await createdFrom(await save([{ role: 'tenant', chipsCount: 1, lease: true }], { test: true, extra: { acceptRenterTerms: true } }));
    const b = await createdFrom(await save([{ role: 'tenant', chipsCount: 1, lease: true }], { test: true, extra: { acceptRenterTerms: true } }));
    const keyA = a.leaseKeys[0]!;
    const keyB = b.leaseKeys[0]!;
    expect(keyA).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(keyB).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(keyA).not.toBe(keyB);
    uploadChipOrderLease.mockClear();

    // Its own key, no new file: the lease stays, nothing is uploaded or removed.
    let res = await save([{ role: 'tenant', chipsCount: 2, leaseKey: keyA }], { test: true, trackingToken: a.trackingToken, extra: { acceptRenterTerms: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, total: 2 * PRICE, leaseKeys: [keyA] });
    expect(uploadChipOrderLease).not.toHaveBeenCalled();
    expect(await holdersOf(a.id)).toEqual([{ full_name: 'דנה בדיקה', chips_count: 2, role: 'tenant', lease_file_key: keyA, apartment_number: APT1 }]);
    expect((await pool.query(`select lease_file_name from public.chip_order_holders where order_id = $1`, [a.id])).rows).toEqual([{ lease_file_name: 'lease-0.pdf' }]);
    await runAfter();
    expect(removedLeases.flat()).toEqual([]);

    // The key of order B on order A: refused, and neither order changes.
    res = await save([{ role: 'tenant', chipsCount: 1, leaseKey: keyB }], { test: true, trackingToken: a.trackingToken, extra: { acceptRenterTerms: true } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, state: 'lease_missing' });
    expect((await holdersOf(a.id)).map((h) => h.lease_file_key)).toEqual([keyA]);
    expect((await holdersOf(b.id)).map((h) => h.lease_file_key)).toEqual([keyB]);
    expect((await rowOf(a.id)).total).toBe(2 * PRICE);
    await runAfter();
    expect(removedLeases.flat()).toEqual([]);

    // The renter row becomes an owner row: nothing holds A's lease any more —
    // removed from Storage once the answer has gone (never B's).
    res = await save([{ chipsCount: 1 }], { test: true, trackingToken: a.trackingToken });
    expect(res.status).toBe(200);
    expect((await res.json()).leaseKeys).toEqual([null]);
    expect(removedLeases.flat()).toEqual([]);
    await runAfter();
    expect(removedLeases).toContainEqual([keyA]);
    expect(removedLeases.flat()).not.toContain(keyB);
    expect((await holdersOf(a.id)).map((h) => h.lease_file_key)).toEqual([null]);
  });

  // 2.2 (Ronen, 27/11/2026): a lease reaches the server only with the order,
  // when the resident continues to payment — never before, never alone.
  it('2.2 — the lease travels with the order: a save of the details before the agreement keeps renter rows with no lease (nothing uploaded); no payment window opens while a renter lacks the lease (409 lease_required); the save that records the agreement must hold every lease — two renters in two apartments in ONE submit, each file checked again — and then the window opens', async () => {
    await setSettings({ unitPrice: PRICE, ordersOpen: false });
    const people = (extra: Partial<RowIn> = {}): RowIn[] => [
      { role: 'tenant', chipsCount: 1, ...extra },
      { role: 'tenant', chipsCount: 1, apartment: APT2, fullName: 'שרה בדיקה', ...extra },
    ];
    // The details, the boxes not ticked yet: accepted with no file.
    const draft = await createdFrom(await save(people(), { test: true, extra: { acceptTerms: false } }));
    expect(uploadChipOrderLease).not.toHaveBeenCalled();
    expect(draft.leaseKeys).toEqual([null, null]);
    expect((await holdersOf(draft.id)).map((h) => [h.apartment_number, h.lease_file_key])).toEqual([[APT1, null], [APT2, null]]);

    // The agreement on the order (as a tab of an older page could leave it),
    // the leases still missing: no payment window, PayPlus never asked.
    await pool.query(`update public.chip_orders set terms_accepted_at = now(), renter_terms_accepted_at = now() where id = $1`, [draft.id]);
    const refused = await openSession(draft, true);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, state: 'lease_required', message: 'נדרש לצרף חוזה או הסכם ניהול לכל שוכר לפני התשלום.' });
    expect(generated()).toEqual([]);

    // The save that continues to payment without the files: refused, row by row.
    let res = await save(people(), { test: true, trackingToken: draft.trackingToken, extra: { acceptRenterTerms: true } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, message: 'נדרש לצרף חוזה או הסכם ניהול (שורה 1).' });
    // A file that is not what its name says: refused on the server too, nothing stored.
    const fake = new File([Buffer.from('this is not a pdf at all')], 'lease.pdf', { type: 'application/pdf' });
    res = await save([{ role: 'tenant', chipsCount: 1, lease: true }, { role: 'tenant', chipsCount: 1, apartment: APT2, fullName: 'שרה בדיקה', lease: true, leaseFile: fake }],
      { test: true, trackingToken: draft.trackingToken, extra: { acceptRenterTerms: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('(שורה 2)');
    expect(uploadChipOrderLease).not.toHaveBeenCalled();
    expect((await holdersOf(draft.id)).map((h) => h.lease_file_key)).toEqual([null, null]);

    // Both leases in ONE submit, with the agreement: each on its own row.
    res = await save(people({ lease: true }), { test: true, trackingToken: draft.trackingToken, extra: { acceptRenterTerms: true } });
    expect(res.status).toBe(200);
    const keys = ((await res.json()) as { leaseKeys: (string | null)[] }).leaseKeys;
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => typeof k === 'string' && /^[0-9a-f-]{36}\.pdf$/.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(uploadChipOrderLease).toHaveBeenCalledTimes(2);
    expect((await holdersOf(draft.id)).map((h) => [h.apartment_number, h.lease_file_key])).toEqual([[APT1, keys[0]], [APT2, keys[1]]]);

    // Every lease on the order: the window opens.
    expect((await openSession(draft, true)).status).toBe(200);
    expect(generated()).toHaveLength(1);
  });

  it('a new total on an order that had a payment session asks PayPlus first: no answer → 502 and nothing changes; nothing charged → that session is DISABLED and the save goes through; the same total → PayPlus is not asked', async () => {
    const t = asMade(await createdFrom(await save([{ chipsCount: 2 }], { test: true })));
    const s1 = await sessionOf(t, true);
    sent.length = 0;

    // The same total (another name): not asked, nothing disabled.
    let res = await save([{ chipsCount: 2, fullName: 'שם אחר' }], { test: true, trackingToken: t.trackingToken });
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);

    // PayPlus does not answer: 502, nothing changed.
    ipn.set(s1, UNREACHABLE);
    res = await save([{ chipsCount: 3 }], { test: true, trackingToken: t.trackingToken });
    expect(res.status).toBe(502);
    expect(ipnAsked()).toEqual([s1]);
    expect(disabled()).toEqual([]);
    expect(await rowOf(t.id)).toMatchObject({ status: 'pending_payment', total: 2 * PRICE, card_status: 'started', card_page_request_uid: s1 });
    expect((await holdersOf(t.id)).map((h) => [h.full_name, h.chips_count])).toEqual([['שם אחר', 2]]);

    // Nothing was charged on it: the session of the old amount is disabled, then the new total is saved.
    sent.length = 0;
    ipn.set(s1, NOT_CHARGED);
    res = await save([{ chipsCount: 3 }], { test: true, trackingToken: t.trackingToken });
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(3 * PRICE);
    expect(sent.map((s) => s.path)).toEqual(['/api/v1.0/PaymentPages/ipn', `/api/v1.0/PaymentPages/Disable/${s1}`]);
    expect(sent.every((s) => s.origin === ORIGIN.sandbox && s.apiKey === DEV.api)).toBe(true);
    expect(await rowOf(t.id)).toMatchObject({ status: 'pending_payment', total: 3 * PRICE });
  });

  it('…and when PayPlus reports a charge on that session, the new total is refused (409 paid) and the order is paid from it — once, with its message', async () => {
    const t = asMade(await createdFrom(await save([{ chipsCount: 2 }], { test: true })));
    const s1 = await sessionOf(t, true);
    sent.length = 0;
    ipn.set(s1, charged(t, s1));
    const res = await save([{ chipsCount: 4 }], { test: true, trackingToken: t.trackingToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'paid' });
    expect(disabled()).toEqual([]);
    expect(await rowOf(t.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'sandbox', total: 2 * PRICE, card_page_request_uid: s1, card_last4: CARD.four });
    expect((await holdersOf(t.id)).map((h) => h.chips_count)).toEqual([2]);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(afterOrderPaid).toHaveBeenCalledWith(t.id);
    expect(notifyChipOrder.mock.calls).toEqual([[t.id, 'paid']]);
    expect(await auditCount(t.id, 'paid')).toBe(1);
  });

  // ── The payment session ──────────────────────────────────────────────────

  it('a REAL order, with real charging armed, opens a PRODUCTION session — the production host and keys, the server\'s amount, a callback that names production — stored with its amount', async () => {
    await armLive();
    const real = await makeOrder({ isTest: false, chips: 3 });
    const res = await openSession(real, false);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { page_request_uid: string; origin: string; amount: number };
    expect(Object.keys(data).sort()).toEqual(['amount', 'hosted_fields_uuid', 'ok', 'origin', 'page_request_uid']);
    expect(data).toMatchObject({ ok: true, origin: ORIGIN.production, amount: 3 * PRICE });
    for (const secret of [PROD.api, PROD.secret, DEV.api, DEV.secret]) expect(JSON.stringify(data)).not.toContain(secret);
    expect(generated()).toHaveLength(1);
    expect(generated()[0]).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api, secretKey: PROD.secret });
    expect(generated()[0]!.body).toMatchObject({
      payment_page_uid: PROD.page, amount: 3 * PRICE, more_info: String(real.number),
      refURL_callback: `${APP_URL}/api/public/chip-order/payplus/callback?env=production`, refURL_origin: APP_URL,
    });
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_status: 'started', card_env: 'production', card_page_request_uid: data.page_request_uid });
    expect(await sessionsOf(real.id)).toEqual([{ page_request_uid: data.page_request_uid, env: 'production', amount: 3 * PRICE }]);
  });

  it('a REAL order without the live switch — or with the page switch off — gets no session: 403, and PayPlus is not called', async () => {
    const real = await makeOrder({ isTest: false });
    await setSettings({ ordersOpen: true });
    expect((await openSession(real, false)).status).toBe(403); // the switch unset — its default
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'off';
    expect((await openSession(real, false)).status).toBe(403);
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'on';
    await setSettings({ ordersOpen: false });
    expect((await openSession(real, false)).status).toBe(403); // armed, but the page is closed
    expect(sent).toEqual([]);
    expect((await rowOf(real.id)).card_status).toBeNull();
  });

  it('a TEST order pays in the sandbox even while production is armed — and a session\'s environment is always the order\'s kind', async () => {
    await armLive();
    const t = await makeOrder({ isTest: true, chips: 2 });
    const res = await openSession(t, true);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { page_request_uid: string; origin: string; amount: number };
    expect(data).toMatchObject({ origin: ORIGIN.sandbox, amount: 2 * PRICE });
    expect(generated()[0]).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api });
    expect(generated()[0]!.body).toMatchObject({ payment_page_uid: DEV.page, refURL_callback: `${APP_URL}/api/public/chip-order/payplus/callback?env=sandbox` });
    expect(await sessionsOf(t.id)).toEqual([{ page_request_uid: data.page_request_uid, env: 'sandbox', amount: 2 * PRICE }]);
    sent.length = 0;
    // The test order's token WITHOUT the test link → the production configuration: not this order's kind.
    expect((await openSession(t, false)).status).toBe(409);
    // A real order's token WITH the test link → the sandbox: not that order's kind either.
    const real = await makeOrder({ isTest: false });
    expect((await openSession(real, true)).status).toBe(409);
    expect(sent).toEqual([]);
    expect((await rowOf(real.id)).card_status).toBeNull();
  });

  it('a second session: the first is looked up, then DISABLED, and only then is the new one opened', async () => {
    const t = await makeOrder({ isTest: true });
    const s1 = await sessionOf(t, true);
    sent.length = 0;
    ipn.set(s1, NOT_CHARGED);
    const s2 = await sessionOf(t, true);
    expect(s2).not.toBe(s1);
    expect(sent.map((s) => s.path)).toEqual(['/api/v1.0/PaymentPages/ipn', `/api/v1.0/PaymentPages/Disable/${s1}`, '/api/v1.0/PaymentPages/generateLink']);
    expect(sent[1]).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api, secretKey: DEV.secret, body: {} });
    expect((await sessionsOf(t.id)).map((s) => s.page_request_uid)).toEqual([s1, s2]);
  });

  it('a price change in the settings since the order was saved: 409 price_changed, no session — the order saved again opens at the new amount', async () => {
    const t = await makeOrder({ isTest: true, chips: 2 });
    await setSettings({ unitPrice: PRICE + 10 });
    const res = await openSession(t, true);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, state: 'price_changed' });
    expect(sent).toEqual([]);
    expect((await rowOf(t.id)).card_status).toBeNull();
    const resaved = await save([{ chipsCount: 2 }], { test: true, trackingToken: t.trackingToken });
    expect(resaved.status).toBe(200);
    expect((await resaved.json()).total).toBe(2 * (PRICE + 10));
    const reopened = await openSession(t, true);
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).amount).toBe(2 * (PRICE + 10));
  });

  // ── The callback ─────────────────────────────────────────────────────────

  it('the callback validates with the secret of the environment its URL names — and applies under it', async () => {
    await armLive();
    const t = await makeOrder({ isTest: true });
    const real = await makeOrder({ isTest: false });
    const st = await sessionOf(t, true);
    const sr = await sessionOf(real, false);
    const forTest = notice(t, st);
    const forReal = notice(real, sr);

    // ?env=sandbox: the DEV secret only — a body signed with the PROD secret is refused.
    expect((await callback(forReal, { env: 'sandbox', key: PROD.secret })).status).toBe(401);
    expect((await callback(forTest, { env: 'sandbox', key: PROD.secret })).status).toBe(401);
    // ?env=production: the PROD secret only.
    expect((await callback(forTest, { env: 'production', key: DEV.secret })).status).toBe(401);
    expect((await callback(forReal, { env: 'production', key: DEV.secret })).status).toBe(401);
    // An environment nobody knows.
    expect((await callback(forTest, { env: 'live', key: DEV.secret })).status).toBe(401);
    for (const o of [t, real]) expect(await rowOf(o.id)).toMatchObject({ status: 'pending_payment', card_status: 'started' });
    expect(afterQueue).toHaveLength(0);

    // The right pairs.
    expect((await callback(forTest, { env: 'sandbox', key: DEV.secret })).status).toBe(200);
    expect((await callback(forReal, { env: 'production', key: PROD.secret })).status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'sandbox', card_transaction_uid: forTest.transaction.uid });
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'production', card_transaction_uid: forReal.transaction.uid, card_last4: CARD.four });
    const audit = (await pool.query(`select metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'paid'`, [real.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ source: 'payplus_callback', provider: 'payplus', env: 'production', transaction_uid: forReal.transaction.uid });
    expect(afterQueue).toHaveLength(2);
    await runAfter();
    expect(notifyChipOrder.mock.calls).toEqual(expect.arrayContaining([[t.id, 'paid'], [real.id, 'paid']]));
    expect(notifyChipOrder).toHaveBeenCalledTimes(2);

    // A paid real order is no longer edited by the form.
    const res = await save([{ chipsCount: 5 }], { test: false, trackingToken: real.trackingToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: 'paid' });
  });

  it('a callback URL with no ?env= (a session opened before 26/11/2026) is tried against each configured secret — and applied under the one that validated it', async () => {
    await armLive();
    const t = await makeOrder({ isTest: true });
    const real = await makeOrder({ isTest: false });
    const other = await makeOrder({ isTest: true });
    const st = await sessionOf(t, true);
    const sr = await sessionOf(real, false);
    const so = await sessionOf(other, true);

    expect((await callback(notice(t, st), { key: DEV.secret })).status).toBe(200);
    expect((await callback(notice(real, sr), { key: PROD.secret })).status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ status: 'paid', card_env: 'sandbox' });
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_env: 'production' });

    // A TEST order's notice signed with the PRODUCTION secret validates as production —
    // and a production charge never pays a test order (recorded once as an anomaly).
    const crossed = notice(other, so);
    expect((await callback(crossed, { key: PROD.secret })).status).toBe(200);
    expect(await rowOf(other.id)).toMatchObject({ status: 'pending_payment', card_status: 'started', card_transaction_uid: null });
    expect(await auditCount(other.id, 'card_payment_anomaly')).toBe(1);

    // With the production values gone, a PROD-signed notice validates nowhere.
    delete fakeEnv.PAYPLUS_PROD_SECRET_KEY;
    expect((await callback(crossed, { key: PROD.secret })).status).toBe(401);
    expect((await callback(notice(real, sr), { key: PROD.secret })).status).toBe(401);
  });

  // ── The status (the lookup) after the switch went off ───────────────────

  it('status: a real order\'s charge is still found after the live switch went off — the lookup needs only the production values', async () => {
    await armLive();
    const real = await makeOrder({ isTest: false });
    const sr = await sessionOf(real, false);
    delete fakeEnv.PAYPLUS_LIVE_CHARGING;
    await setSettings({ ordersOpen: false });
    sent.length = 0;
    ipn.set(sr, charged(real, sr));
    // The test link names a test order — this one is real: refused.
    expect((await askStatus(real, true)).status).toBe(409);
    const res = await askStatus(real, false);
    expect(await res.json()).toMatchObject({ ok: true, state: 'paid', orderNumber: real.number });
    expect(askedAbout(sr)).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api });
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'production' });
    await runAfter();
    expect(notifyChipOrder.mock.calls).toEqual([[real.id, 'paid']]);
  });

  // Regression (review, 26/11): PayPlus's hosted-fields notice names no session,
  // and a late or resent one can come after the everyday 45 minutes. The
  // order's sessions of the reconcile window are asked about before such a
  // charge is called an anomaly (an alert telling the admins to refund it).
  it('a LATE notice that names no session — its session is 2 hours old — is checked over the reconcile window: paid, never a "no session" anomaly', async () => {
    const t = await makeOrder({ isTest: true });
    const s = await withSession(t, 'sandbox', 120);
    ipn.set(s, charged(t, s));
    expect((await callback(notice(t, null), { env: 'sandbox', key: DEV.secret })).status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'sandbox', card_page_request_uid: s });
    expect(ipnAsked()).toContain(s);
    const anomalies = await pool.query(
      `select 1 from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'card_payment_anomaly'`, [t.id],
    );
    expect(anomalies.rowCount).toBe(0);
    expect(afterQueue).toHaveLength(1);
  });

  // Regression (review, 26/11): a save that changed the total while a session
  // was being opened wins — the session of the old amount is never stored.
  it('a payment session is stored only while the order\'s total is still its amount: another amount → false, nothing stored', async () => {
    const t = await makeOrder({ isTest: true });
    expect(await setCardSession(t.id, { env: 'sandbox', pageRequestUid: `${RUN}-eeee-4eee-8eee-000000000001`, amount: t.total + 40 })).toBe(false);
    expect((await pool.query(`select 1 from public.chip_order_card_sessions where order_id = $1`, [t.id])).rowCount).toBe(0);
    expect(await rowOf(t.id)).toMatchObject({ card_status: null, card_page_request_uid: null });
    expect(await setCardSession(t.id, { env: 'sandbox', pageRequestUid: `${RUN}-eeee-4eee-8eee-000000000002`, amount: t.total })).toBe(true);
    expect(await rowOf(t.id)).toMatchObject({ card_status: 'started', card_page_request_uid: `${RUN}-eeee-4eee-8eee-000000000002` });
  });

  // ── The hourly run ───────────────────────────────────────────────────────

  it('reconcile: a waiting order whose session is 20 minutes old is looked up and paid from an approved charge of its EXACT total; a 2-minute-old session is not looked up yet', async () => {
    // The live switch is off: looking up needs only each environment's values.
    const real = await makeOrder({ isTest: false });
    const test = await makeOrder({ isTest: true });
    const young = await makeOrder({ isTest: false });
    const otherAmount = await makeOrder({ isTest: false });
    const sReal = await withSession(real, 'production', 20);
    const sTest = await withSession(test, 'sandbox', 20);
    const sYoung = await withSession(young, 'production', 2);
    const sOther = await withSession(otherAmount, 'production', 20);
    ipn.set(sReal, charged(real, sReal));
    ipn.set(sTest, charged(test, sTest));
    ipn.set(sYoung, charged(young, sYoung));
    ipn.set(sOther, charged(otherAmount, sOther, { amount: otherAmount.total + 1 }));

    const r = await reconcilePendingCardOrders();
    expect(r.paidOrderIds).toEqual(expect.arrayContaining([real.id, test.id]));
    expect(r.paidOrderIds).not.toContain(young.id);
    expect(r.paidOrderIds).not.toContain(otherAmount.id);
    expect(r.movedToPaid).toBeGreaterThanOrEqual(2);
    expect(r.unknown).toBeGreaterThanOrEqual(1); // a charge of another amount is for a person to look at
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'production', card_page_request_uid: sReal });
    expect(await rowOf(test.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'sandbox' });
    expect(await rowOf(otherAmount.id)).toMatchObject({ status: 'pending_payment', card_status: 'started' });
    expect(await rowOf(young.id)).toMatchObject({ status: 'pending_payment', card_status: 'started' });
    expect(ipnAsked()).toEqual(expect.arrayContaining([sReal, sTest, sOther]));
    expect(ipnAsked()).not.toContain(sYoung);
    // Each environment with its own values.
    expect(askedAbout(sReal)).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api });
    expect(askedAbout(sTest)).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api });
    // The messages are the caller's (the cron route): nothing was queued here.
    expect(afterQueue).toHaveLength(0);
  });

  // ── Decision 3.4 (Ronen, 27/11/2026): read again before "paid" ─────────
  // Before an order is marked paid — by a callback (on time, late or sent
  // again), the order page's check or the hourly reconcile — the charge is
  // read again from PayPlus (Transactions/View by its uid, and the order's
  // refunds by its number). Only an approved charge that is neither cancelled
  // nor refunded there pays the order; otherwise it keeps waiting, with no
  // Morning document. Whatever the notice or the session lookup said.

  const viewAsked = (uid: string) => sent.some((s) => s.path === '/api/v1.0/Transactions/View' && s.body.transaction_uid === uid);
  const docsOf = async (id: string) => Number((await pool.query(
    `select count(*)::int as n from public.chip_order_documents where order_id = $1`, [id])).rows[0].n);
  /** The admins' alerts about the order — their ids go on the list of rows to remove. */
  const alertsOf = async (id: string) => {
    const ids = (await pool.query<{ id: string }>(
      `select id from public.notifications where type = 'chip_order_alert' and source_entity_id = $1`, [id])).rows.map((r) => r.id);
    for (const n of ids) if (!made.notifications.includes(n)) made.notifications.push(n);
    return ids;
  };

  it('3.4 — the callback was lost, the charge is approved in PayPlus: the reconcile reads it again (Transactions/View) and only then marks the order paid — the invoice is queued', async () => {
    const real = await makeOrder({ isTest: false });
    const s = await withSession(real, 'production', 20);
    ipn.set(s, charged(real, s));
    const r = await reconcilePendingCardOrders();
    expect(r.paidOrderIds).toContain(real.id);
    expect(viewAsked(`tx-${RUN}-lk-${real.number}`)).toBe(true);
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_transaction_uid: `tx-${RUN}-lk-${real.number}` });
    expect(await docsOf(real.id)).toBe(1);
  });

  it('3.4 — the callback was lost and the charge was CANCELLED in the PayPlus dashboard: the reconcile does NOT mark the order paid — no Morning document, one anomaly, one alert per admin, and a second run changes nothing', async () => {
    const real = await makeOrder({ isTest: false });
    const s = await withSession(real, 'production', 20);
    ipn.set(s, charged(real, s));
    const uid = `tx-${RUN}-lk-${real.number}`;
    view.set(uid, viewed(uid, real, { transaction_is_cancelled: true }));
    const r = await reconcilePendingCardOrders();
    expect(r.paidOrderIds).not.toContain(real.id);
    expect(viewAsked(uid)).toBe(true);
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_status: 'started', card_transaction_uid: null });
    expect(await docsOf(real.id)).toBe(0);
    expect(await auditCount(real.id, 'paid')).toBe(0);
    expect(await auditCount(real.id, 'card_payment_anomaly')).toBe(1);
    const alerts = await alertsOf(real.id);
    expect(alerts.length).toBeGreaterThan(0);
    await reconcilePendingCardOrders();
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment' });
    expect(await auditCount(real.id, 'card_payment_anomaly')).toBe(1);
    expect(await alertsOf(real.id)).toHaveLength(alerts.length);
  });

  it('3.4 — PayPlus shows the transaction as something other than an approved CHARGE (a refund under the same uid, or a declined status): the order is not paid, no Morning document, one anomaly', async () => {
    for (const over of [{ transaction_type: 'Refund' }, { status_code: '006' }]) {
      const real = await makeOrder({ isTest: false });
      const s = await withSession(real, 'production', 20);
      ipn.set(s, charged(real, s));
      const uid = `tx-${RUN}-lk-${real.number}`;
      view.set(uid, viewed(uid, real, over));
      const r = await reconcilePendingCardOrders();
      expect(r.paidOrderIds, JSON.stringify(over)).not.toContain(real.id);
      expect(viewAsked(uid)).toBe(true);
      expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_transaction_uid: null });
      expect(await docsOf(real.id)).toBe(0);
      expect(await auditCount(real.id, 'paid')).toBe(0);
      expect(await auditCount(real.id, 'card_payment_anomaly')).toBe(1);
    }
  });

  it('3.4 — the order page checks the payment after the charge was cancelled in the dashboard: not paid, no document — and a new payment window may open (nothing is charged)', async () => {
    await armLive();
    const real = await makeOrder({ isTest: false });
    const s = await sessionOf(real, false);
    ipn.set(s, charged(real, s));
    const uid = `tx-${RUN}-lk-${real.number}`;
    view.set(uid, viewed(uid, real, { transaction_is_cancelled: true }));
    const res = await askStatus(real, false);
    expect(await res.json()).toMatchObject({ ok: true, state: 'pending', charged: 'no' });
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_transaction_uid: null });
    expect(await docsOf(real.id)).toBe(0);
    expect(afterQueue).toHaveLength(0);
    await alertsOf(real.id);
    const next = await openSession(real, false);
    expect(next.status).toBe(200);
    expect(disabled()).toContain(s);
  });

  it('3.4 — a LATE callback that names its session arrives after the charge was REFUNDED in the dashboard: not paid, no document, no message', async () => {
    await armLive();
    const real = await makeOrder({ isTest: false });
    const s = await sessionOf(real, false);
    const n = notice(real, s);
    viewByMoreInfo.set(String(real.number), () => reply(200, {
      results: { status: 'success', code: 0 },
      data: [{ transaction: {
        transaction_uid: `rf-${RUN}-${real.number}`, transaction_type: 'Refund', status_code: '000', transaction_is_cancelled: false,
        amount: real.total, more_info: String(real.number),
      } }],
    }));
    const res = await callback(n, { env: 'production', key: PROD.secret });
    expect(res.status).toBe(200);
    expect(viewAsked(n.transaction.uid)).toBe(true);
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_transaction_uid: null });
    expect(await docsOf(real.id)).toBe(0);
    expect(afterQueue).toHaveLength(0);
    expect(await auditCount(real.id, 'card_payment_anomaly')).toBe(1);
    await alertsOf(real.id);
  });

  it('3.4 — a callback while PayPlus does not answer the second reading: 503 (PayPlus sends it again) and the order keeps waiting; the resend, with PayPlus showing the charge approved, pays it — the invoice once', async () => {
    await armLive();
    const real = await makeOrder({ isTest: false });
    const s = await sessionOf(real, false);
    const n = notice(real, s);
    view.set(n.transaction.uid, () => reply(500, { message: 'down' }));
    expect((await callback(n, { env: 'production', key: PROD.secret })).status).toBe(503);
    expect(await rowOf(real.id)).toMatchObject({ status: 'pending_payment', card_transaction_uid: null });
    expect(await docsOf(real.id)).toBe(0);
    view.delete(n.transaction.uid);
    expect((await callback(n, { env: 'production', key: PROD.secret })).status).toBe(200);
    expect(await rowOf(real.id)).toMatchObject({ status: 'paid', card_transaction_uid: n.transaction.uid });
    expect(await docsOf(real.id)).toBe(1);
    expect(afterQueue).toHaveLength(1);
    // The same notice once more: nothing new.
    expect((await callback(n, { env: 'production', key: PROD.secret })).status).toBe(200);
    expect(await docsOf(real.id)).toBe(1);
    expect(afterQueue).toHaveLength(1);
  });

  it('purge: an unpaid real order older than 48 hours is LOOKED UP over every session it had (here one 3 hours old) before anything is deleted', async () => {
    const wasPaid = await makeOrder({ isTest: false });
    const notCharged = await makeOrder({ isTest: false });
    const unreachable = await makeOrder({ isTest: false });
    const grow = await makeOrder({ isTest: false });
    const sPaid = await withSession(wasPaid, 'production', 180);
    const sNot = await withSession(notCharged, 'production', 180);
    const sDown = await withSession(unreachable, 'production', 180);
    for (const o of [wasPaid, notCharged, unreachable, grow]) await makeStale(o);
    await pool.query(`update public.chip_orders set grow_process_id = $2, grow_process_token = 'tok' where id = $1`, [grow.id, `p-${RUN}-${grow.number}`]);
    // The everyday lookup (the last 45 minutes) would not even see these sessions.
    expect(await listRecentCardSessions(wasPaid.id, 'production', 4)).toEqual([]);
    ipn.set(sPaid, charged(wasPaid, sPaid));
    ipn.set(sNot, NOT_CHARGED);
    ipn.set(sDown, UNREACHABLE);

    const r = await purgeUnpaidChipOrders();
    expect(r).not.toHaveProperty('skippedGrowUnavailable');
    expect(r).not.toHaveProperty('skippedGrowError');
    for (const s of [sPaid, sNot, sDown]) expect(askedAbout(s)).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api });
    // PayPlus says it WAS paid → paid, not deleted (its message is the caller's to send).
    expect(r.movedToPaid).toBeGreaterThanOrEqual(1);
    expect(r.paidOrderIds).toContain(wasPaid.id);
    expect(await rowOf(wasPaid.id)).toMatchObject({ status: 'paid', card_status: 'paid', card_env: 'production', card_page_request_uid: sPaid });
    // Nothing charged → deleted.
    expect(await exists(notCharged.id)).toBe(false);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    // PayPlus not answering → kept for the next run.
    expect(await exists(unreachable.id)).toBe(true);
    expect(r.skippedLookupError).toBeGreaterThanOrEqual(1);
    // The former processor's order → never deleted.
    expect(await exists(grow.id)).toBe(true);
    expect(r.skippedUnverifiable).toBeGreaterThanOrEqual(1);
    expect(afterQueue).toHaveLength(0);

    // Without the production values the kept order cannot be checked at all → kept again, not asked.
    delete fakeEnv.PAYPLUS_PROD_API_KEY;
    sent.length = 0;
    const again = await purgeUnpaidChipOrders();
    expect(await exists(unreachable.id)).toBe(true);
    expect(again.skippedUnverifiable).toBeGreaterThanOrEqual(2);
    expect(ipnAsked()).not.toContain(sDown);
  });

  // ── The log ──────────────────────────────────────────────────────────────

  it('no card data is logged: the callback never hands the raw body or a card field to the logger', async () => {
    const t = await makeOrder({ isTest: true });
    const other = await makeOrder({ isTest: true });
    const st = await sessionOf(t, true);
    const so = await sessionOf(other, true);
    logged.length = 0;

    // 1. A notice that names no session: the field NAMES are logged, PayPlus is asked
    //    (its answer carries the card fields too) and pays the order.
    ipn.set(st, charged(t, st));
    const withoutSession = notice(t, null);
    expect((await callback(withoutSession, { env: 'sandbox', key: DEV.secret })).status).toBe(200);
    expect((await rowOf(t.id)).status).toBe('paid');
    // 2. A forged notice: its refusal is logged.
    expect((await callback(notice(t, st), { env: 'sandbox', key: 'not-our-secret' })).status).toBe(401);
    // 3. An approved charge of another amount: an error line with the amounts.
    expect((await callback(notice(other, so, { amount: other.total + 1 }), { env: 'sandbox', key: DEV.secret })).status).toBe(200);
    expect((await rowOf(other.id)).status).toBe('pending_payment');
    // 4. A body that holds no transaction at all — only the card.
    expect((await callback({ data: { card_information: notice(t, st).data.card_information } }, { env: 'sandbox', key: DEV.secret })).status).toBe(200);

    expect(logged.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(logged, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
    // The names reached the log (so the lines checked below are real lines)…
    expect(text).toContain('data.card_information.identification_number');
    // …and none of the values did, nor the body itself.
    for (const value of [CARD.id, CARD.bin, CARD.holder, `${CARD.month}/${CARD.year}`]) expect(text).not.toContain(value);
    expect(text).not.toContain(JSON.stringify(withoutSession));
    // The short values (the last four digits, the expiry), wherever a STRING
    // carries them on its own — a number (an order number, an amount) is not card data.
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(JSON.parse(text));
    for (const short of [CARD.four, CARD.month, CARD.year]) {
      const alone = new RegExp(`(^|[^0-9])${short}([^0-9]|$)`);
      expect(strings.filter((s) => alone.test(s))).toEqual([]);
    }
  });

  it('no request of this file ever left for anywhere but the PayPlus stub', () => {
    expect(fetchMock.mock.calls.every(([input]) => {
      const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
      return origin === ORIGIN.sandbox || origin === ORIGIN.production;
    })).toBe(true);
  });
});

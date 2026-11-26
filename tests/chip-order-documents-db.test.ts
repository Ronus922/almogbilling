import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The Morning documents of chip orders (26/11/2026) against a throwaway
// database (WA_TEST_DATABASE_URL), never prod: the queue
// (chip_order_documents, src/lib/db/chipOrderDocuments.ts), the issuer
// (src/lib/chipOrders/documents.ts), the points that enqueue (a production
// card charge, a reception payment in cash or by transfer, the cancellation of
// a reception order) and "הפק חשבונית שוב". What must hold:
//   - no Morning key → a document is QUEUED with the payment, nothing is
//     attempted, the order says it waits;
//   - a test order (the sandbox) never gets a document;
//   - with a key, a due row is issued ONCE (one POST /documents, the body
//     field by field), mirrored onto the order, and never again — the same
//     charge reported twice is still one row;
//   - what may pass by itself is retried with a backoff; the last attempt, or
//     a refusal of the request itself, fails the row and alerts every active
//     admin once; "הפק חשבונית שוב" (admins only) puts it back;
//   - a row a crashed run left 'issuing' is first searched for in Morning (its
//     ref is in the remarks) and adopted, never issued twice;
//   - a cancelled cash order is credited: 330 + a negative 400 (a VAT
//     business), one negative 400 (an exempt one).
// Morning and PayPlus are never called: fetch is a stub that answers by URL
// and refuses anything else. Email and WhatsApp senders are stubbed. Rows are
// removed by the exact ids made here.

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

// Nothing is mailed or sent on WhatsApp: the customer's messages and the
// admins' alerts reach these stubs (and the rows they record are real).
const sendWithRetry = vi.fn<(args: { to: string; subject: string }) => Promise<{ messageId: string; attempts: number }>>(
  async () => ({ messageId: 'test', attempts: 1 }),
);
vi.mock('@/lib/email/send', async (orig) => ({ ...(await orig<typeof import('@/lib/email/send')>()), sendWithRetry }));
vi.mock('@/lib/db/whatsappInstances', async (orig) => ({
  ...(await orig<typeof import('@/lib/db/whatsappInstances')>()),
  getDefaultSendCreds: async () => null,
}));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendWhatsAppMessage: vi.fn(async () => { throw new Error('no WhatsApp in this test'); }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN = String(Date.now()).slice(-8);
const tag = RUN.slice(-6);
const PRICE = 40;
const APP_URL = 'https://chips.example.test';
const MORNING_KEY = { id: 'morning-docs-test-key-id', secret: 'morning-docs-test-key-secret' };
const PROD = { api: 'prod-api-key-docs-test', secret: 'prod-secret-key-docs-test', page: '99999999-8888-7777-6666-555555555555' };
const DEV = { api: 'dev-api-key-docs-test', secret: 'dev-secret-key-docs-test', page: '11111111-2222-3333-4444-555555555555' };
const PHONE = '+972539500071';
const APT = { web: `981${tag}1`, reception: `981${tag}2` };
const ORDERER = 'דנה בדיקה';
const EMAIL = 'docs-test@example.test';

const orders = await import('@/lib/db/chipOrders');
const { setCardSession, recordCardPayment } = await import('@/lib/db/chipOrderCard');
const { enqueueDocumentInTx } = await import('@/lib/db/chipOrderDocuments');
const { saveReceptionWindow } = await import('@/lib/db/chipReception');
const { getChipOrderWindow, saveChipOrderWindow } = await import('@/lib/db/chipOrderWindow');
const { processDueDocuments, MAX_DOCUMENT_ATTEMPTS, __resetMorningProfileForTests } = await import('@/lib/chipOrders/documents');
const { __resetMorningTokenForTests } = await import('@/lib/morning/client');
const { israelDate } = await import('@/lib/morning/documents');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');
const { EMPTY_RECEPTION_ORDERER } = await import('@/lib/chipOrders/reception');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const { POST: retryRoute } = await import('@/app/api/chip-orders/[id]/documents/retry/route');

const SETTINGS = { ...DEFAULT_CHIP_ORDER_SETTINGS, unitPrice: PRICE };
const made = { contacts: {} as Record<string, string>, orders: [] as string[], users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: string }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
let admin: { id: string; name: string };

/** Morning ON (the building's key) or OFF. */
function morningOn(on: boolean) {
  if (on) Object.assign(fakeEnv, { MORNING_API_KEY_ID: MORNING_KEY.id, MORNING_API_KEY_SECRET: MORNING_KEY.secret });
  else { delete fakeEnv.MORNING_API_KEY_ID; delete fakeEnv.MORNING_API_KEY_SECRET; }
  __resetMorningProfileForTests();
  __resetMorningTokenForTests();
}

// ── The network: Morning and PayPlus, as a stub that answers by URL ─────────

const MORNING_API = 'https://api.greeninvoice.co.il';
const MORNING_TOKEN = 'https://api.morning.co/idp/v1/oauth/token';
interface Sent { url: string; path: string; method: string; body: Record<string, unknown> | null; auth: string | null }
const sent: Sent[] = [];
const elsewhere: string[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** What the building's Morning account answers — set per test. */
const morning = {
  me: { type: 1, exemption: false } as Record<string, unknown> | null,
  info: { exemption: false, vatRate: 0.18 } as Record<string, unknown>,
  types: [{ id: 305 }, { id: 320 }, { id: 330 }, { id: 400 }] as unknown[],
  /** POST /documents — null (or an answer of null) = Morning creates the document. */
  create: null as null | ((body: Record<string, unknown>) => Response | null),
  search: [] as unknown[],
  /** Holds the FIRST POST /documents until `release` resolves (records its ref, calls `reached`). */
  hold: null as null | { ref: string | null; reached: () => void; release: Promise<void> },
};
let docSeq = 0;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  const auth = new Headers(init?.headers).get('authorization');
  const path = url.origin === MORNING_API ? url.pathname.replace(/^\/api\/v1/, '') + url.search : url.pathname;
  sent.push({ url: url.href, path, method: init?.method ?? 'GET', body, auth });
  if (url.href === MORNING_TOKEN) {
    return reply(200, { accessToken: `docs-token-${RUN}`, tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.origin === MORNING_API) {
    if (path === '/businesses/me') return morning.me ? reply(200, morning.me) : reply(404, { errorMessage: 'not found' });
    if (path === '/documents/info?type=320') return reply(200, morning.info);
    if (path === '/documents/types?lang=he') return reply(200, morning.types);
    if (path === '/documents' && init?.method === 'POST') {
      const hold = morning.hold;
      if (hold && hold.ref === null) {
        hold.ref = String(body?.remarks ?? '').replace('מזהה: ', '');
        hold.reached();
        await hold.release;
      }
      const custom = morning.create?.(body ?? {}) ?? null;
      if (custom) return custom;
      docSeq += 1;
      return reply(201, {
        id: `mdoc-${RUN}-${docSeq}`, number: 70000 + docSeq, type: body?.type,
        url: { origin: `https://morning.example.test/${RUN}/${docSeq}.pdf`, he: `https://morning.example.test/${RUN}/${docSeq}-he.pdf` },
      });
    }
    if (path === '/documents/search' && init?.method === 'POST') return reply(200, { total: morning.search.length, items: morning.search });
  }
  // PayPlus, read only (27/11/2026): a callback for an order that is ALREADY
  // paid makes the server ask what PayPlus shows — here the charge as it is.
  if (/^https:\/\/restapi(dev)?\.payplus\.co\.il$/.test(url.origin)) {
    if (url.pathname === '/api/v1.0/Transactions/View' && typeof body?.transaction_uid === 'string') {
      return reply(200, { results: { status: 'success', code: 0 }, data: [{ transaction: { transaction_uid: body.transaction_uid, transaction_type: 'Charge', status_code: '000', transaction_is_cancelled: false, amount: 0 }, data: {} }] });
    }
    if (url.pathname === '/api/v1.0/Transactions/View') return reply(200, { results: { status: 'error', code: 1, description: 'no transactions' }, data: {} });
    if (url.pathname === '/api/v1.0/PaymentPages/ipn') return reply(200, { results: { status: 'success', code: 0 }, data: { transaction_uid: 'x', type: 'Charge', status_code: '000' } });
  }
  elsewhere.push(url.href);
  throw new TypeError(`no network in this test: ${url.href}`);
});
const morningCalls = () => sent.filter((s) => s.url.startsWith(MORNING_API) || s.url === MORNING_TOKEN);
/** The POST /documents of one queue row (its ref is printed in the remarks). */
const postsOf = (ref: string) => sent.filter((s) => s.path === '/documents' && s.method === 'POST' && String(s.body?.remarks ?? '').includes(ref));
const searchesOf = () => sent.filter((s) => s.path === '/documents/search');

// ── Orders and rows ─────────────────────────────────────────────────────────

interface Made { id: string; number: number; trackingToken: string; total: number }
async function makeOrder(opts: { isTest: boolean; chips?: number }): Promise<Made> {
  const o = await orders.createChipOrder({
    fullName: ORDERER, phoneE164: PHONE, email: EMAIL, address: 'הרצל 1, חיפה 3300000', role: 'owner',
    rows: [{ role: 'owner', fullName: ORDERER, apartmentNumber: APT.web, chipsCount: opts.chips ?? 3, phoneE164: PHONE, email: null, lease: null, leaseEndDate: null }],
    addressParts: { street: 'הרצל 1', city: 'חיפה', zip: '3300000' },
    ip: '198.51.100.7', isTest: opts.isTest,
  }, SETTINGS);
  made.orders.push(o.id);
  return { id: o.id, number: o.orderNumber, trackingToken: o.trackingToken, total: o.total };
}

let sessionSeq = 0;
async function openSession(o: Made, env: 'sandbox' | 'production'): Promise<string> {
  sessionSeq += 1;
  const uid = `${RUN}-d0c5-4d0c-8d0c-${String(sessionSeq).padStart(12, '0')}`;
  expect(await setCardSession(o.id, { env, pageRequestUid: uid, amount: o.total })).toBe(true);
  return uid;
}
/** A card charge PayPlus confirmed, applied straight to the DB (the callback's own path is tested once, below). */
async function payByCard(o: Made, env: 'sandbox' | 'production'): Promise<{ tx: string; session: string }> {
  const session = await openSession(o, env);
  const tx = `tx-${RUN}-${o.number}-${sessionSeq}`;
  const out = await recordCardPayment({
    env, orderNumber: o.number, transactionUid: tx, pageRequestUid: session, amount: o.total, approvalNumber: '0012345', last4: '9844',
  }, 'payplus_callback');
  expect(out).toEqual({ kind: 'paid', orderId: o.id });
  return { tx, session };
}

const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');
function callback(payload: unknown, env: 'sandbox' | 'production', key: string) {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request(`http://localhost/api/public/chip-order/payplus/callback?env=${env}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body, key) }, body,
  }));
}
const chargeNotice = (o: Made, session: string, uid: string) => ({
  transaction_type: 'Charge',
  transaction: {
    uid, payment_request_uid: session, type: 'internal_page', status_code: '000', amount: o.total, currency: 'ILS',
    payments: { number_of_payments: 1 }, approval_number: '0012345', more_info: String(o.number),
  },
  data: { card_information: { four_digits: '9844', expiry_month: '05', expiry_year: '30', card_bin: '532614' } },
});

interface DocRow {
  id: string; order_id: string; kind: string; payment_key: string; ref: string; amount: number; payment_method: string;
  status: string; attempts: number; next_attempt_at: Date; claimed_at: Date | null; last_error: string | null;
  credit_of: string | null; details: Record<string, unknown>; morning_docs: { type: number; id: string; number: string; url: string | null }[];
  issued_at: Date | null;
}
const docsOf = async (orderId: string): Promise<DocRow[]> => (await pool.query<DocRow>(
  `select id, order_id, kind, payment_key, ref, amount::float8 as amount, payment_method, status, attempts, next_attempt_at, claimed_at,
          last_error, credit_of, details, morning_docs, issued_at
     from public.chip_order_documents where order_id = $1 order by created_at`, [orderId],
)).rows;
const docRow = async (id: string): Promise<DocRow> => (await pool.query<DocRow>(
  `select id, order_id, kind, payment_key, ref, amount::float8 as amount, payment_method, status, attempts, next_attempt_at, claimed_at,
          last_error, credit_of, details, morning_docs, issued_at
     from public.chip_order_documents where id = $1`, [id],
)).rows[0]!;
const orderRow = async (id: string) => (await pool.query<{
  status: string; invoice_number: string | null; invoice_url: string | null; payment_method: string | null; source: string; is_test: boolean;
}>(`select status, invoice_number, invoice_url, payment_method, source, is_test from public.chip_orders where id = $1`, [id])).rows[0]!;
/** Minutes from the database's now() to the row's next attempt. */
const minutesAhead = async (id: string) => Number((await pool.query(
  `select extract(epoch from (next_attempt_at - now())) / 60 as m from public.chip_order_documents where id = $1`, [id],
)).rows[0].m);
const makeDue = (id: string) => pool.query(`update public.chip_order_documents set next_attempt_at = now() where id = $1`, [id]);
const activeAdmins = async () => (await pool.query<{ id: string }>(
  `select id from public.users where is_active = true and role in ('super_admin', 'admin') order by id`,
)).rows.map((r) => r.id);
const alertsOf = async (docId: string) => (await pool.query<{ user_id: string; type: string; title: string; source_entity_id: string | null; priority: string }>(
  `select user_id, type, title, source_entity_id, priority from public.notifications where dedupe_key like $1 order by user_id`, [`chip_doc_failed:${docId}:%`],
)).rows;
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };
const retry = (orderId: string) => retryRoute(
  new Request(`http://localhost/api/chip-orders/${orderId}/documents/retry`, { method: 'POST' }),
  { params: Promise.resolve({ id: orderId }) },
);

/** A reception save of `n` new chips for one guest, settled by `method`. */
let chipSeq = 0;
async function receptionSave(method: 'cash' | 'bank_transfer' | 'none', n: number) {
  const numbers = Array.from({ length: n }, () => { chipSeq += 1; return `D${tag}${chipSeq}`; });
  return saveReceptionWindow(
    { contact_id: made.contacts[APT.reception]!, groups: [{ resident_role: 'other', holder_name: 'אורח בקבלה', chip_type: 'physical', numbers }] },
    { orderer: { ...EMPTY_RECEPTION_ORDERER, name: 'משלם בקבלה' }, payment: { method, amount: method === 'none' ? 0 : n * PRICE } },
    PRICE,
    admin,
  );
}

d('Morning documents of chip orders — the queue, the issuer, and every point that enqueues', () => {
  let p1: Made;
  let p1Tx = '';

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    admin = { id: seeded, name: 'e2e-admin' };
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    const username = `docs-mgr-${tag}`;
    const m = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', 'מנהל בדיקה', 'manager', true) returning id`,
      [username, `${username}@example.test`],
    );
    made.users.push(m.rows[0]!.id);
    users.manager = { id: m.rows[0]!.id, username, email: null, full_name: 'מנהל בדיקה', role: 'manager' };
    // The manager holds every chips permission of the matrix — the retry is still admins' only.
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager.id, mod]);
    }
    for (const apt of Object.values(APT)) {
      const c = await pool.query<{ id: string }>(
        `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539500071') returning id`, [apt]);
      made.contacts[apt] = c.rows[0]!.id;
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    const contactIds = Object.values(made.contacts);
    // The reception orders were made by saves — collect them with the rest.
    const receptionOrders = (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = any($1::uuid[])`,
      [contactIds])).rows.map((r) => r.id);
    const orderIds = [...new Set([...made.orders, ...receptionOrders])];
    const docIds = (await pool.query<{ id: string }>(`select id from public.chip_order_documents where order_id = any($1::uuid[])`, [orderIds])).rows.map((r) => r.id);
    const notificationIds = (await pool.query<{ id: string }>(
      `select id from public.notifications where dedupe_key like any($1::text[])`, [docIds.map((id) => `chip_doc_failed:${id}:%`)],
    )).rows.map((r) => r.id);
    for (const id of notificationIds) await pool.query(`delete from public.notifications where id = $1`, [id]);
    const chipIds = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = any($1::uuid[])`, [contactIds])).rows.map((r) => r.id);
    for (const id of chipIds) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    // Credits first (credit_of → their invoice row), then the rest.
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1 and credit_of is not null`, [id]);
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1`, [id]);
    for (const id of orderIds) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    const records = (await pool.query<{ id: string }>(`select id from public.chip_reception_records where contact_id = any($1::uuid[])`, [contactIds])).rows.map((r) => r.id);
    for (const id of records) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_reception_record' and entity_id = $1`, [id]);
      await pool.query(`delete from public.chip_reception_records where id = $1`, [id]);
    }
    for (const id of contactIds) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.users) {
      await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
      await pool.query(`delete from public.users where id = $1`, [id]);
    }
    await pool.end();
  });

  beforeEach(() => {
    for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
    Object.assign(fakeEnv, {
      APP_URL,
      PAYPLUS_MODE: 'production',
      PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page,
      PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page,
    });
    morningOn(true);
    morning.me = { type: 1, exemption: false };
    morning.info = { exemption: false, vatRate: 0.18 };
    morning.types = [{ id: 305 }, { id: 320 }, { id: 330 }, { id: 400 }];
    morning.create = null;
    morning.search = [];
    morning.hold = null;
    sent.length = 0;
    afterQueue.length = 0;
    sendWithRetry.mockClear();
    h.user = null;
  });

  // ── Test orders ──────────────────────────────────────────────────────────

  it('a TEST order paid in the sandbox never gets a document row — also with Morning connected; a row forced in is failed, never sent', async () => {
    const t = await makeOrder({ isTest: true, chips: 2 });
    await payByCard(t, 'sandbox');
    expect(await docsOf(t.id)).toEqual([]);
    // Asked directly, the queue refuses it as well.
    const c = await pool.connect();
    try {
      expect(await enqueueDocumentInTx(c, { orderId: t.id, kind: 'invoice', paymentKey: `card:forced-${RUN}`, amount: t.total, method: 'card' })).toBeNull();
    } finally { c.release(); }
    expect(await docsOf(t.id)).toEqual([]);

    // A row that got in some other way: the issuer refuses it too, without a word to Morning.
    const ref = `CHF${RUN}`;
    const forced = (await pool.query<{ id: string }>(
      `insert into public.chip_order_documents (order_id, kind, payment_key, ref, amount, payment_method)
       values ($1, 'invoice', $2, $3, $4, 'card') returning id`, [t.id, `card:forced-${RUN}`, ref, t.total])).rows[0]!.id;
    await processDueDocuments();
    expect(postsOf(ref)).toEqual([]);
    expect(await docRow(forced)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'הזמנת בדיקה — לא מופק מסמך', morning_docs: [] });
    expect((await orderRow(t.id)).invoice_number).toBeNull();
  });

  // ── No key: queued, nothing attempted ────────────────────────────────────

  it('NO Morning key: a production charge (the signed callback, twice) queues exactly ONE invoice row — and the issuer attempts nothing', async () => {
    morningOn(false);
    p1 = await makeOrder({ isTest: false, chips: 3 });
    const session = await openSession(p1, 'production');
    p1Tx = `tx-${RUN}-cb-${p1.number}`;
    const notice = chargeNotice(p1, session, p1Tx);
    expect((await callback(notice, 'production', PROD.secret)).status).toBe(200);
    expect((await callback(notice, 'production', PROD.secret)).status).toBe(200);
    expect((await orderRow(p1.id)).status).toBe('paid');

    const rows = await docsOf(p1.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'invoice', payment_key: `card:${p1Tx}`, amount: 3 * PRICE, payment_method: 'card', status: 'pending', attempts: 0,
      claimed_at: null, last_error: null, credit_of: null, morning_docs: [], issued_at: null,
    });
    expect(rows[0]!.ref).toMatch(/^CH[A-Z0-9]{8}$/);
    expect(rows[0]!.details).toMatchObject({ last4: '9844', approval_number: '0012345', provider: 'payplus', date: israelDate() });
    // Nothing of the card beyond the last four digits.
    expect(JSON.stringify(rows[0]!.details)).not.toContain('532614');

    // What follows the payment (once): the issuer runs and does nothing; the "paid" message goes out.
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(await processDueDocuments()).toEqual({ claimed: 0, issued: 0, retried: 0, failed: 0, postponed: 0, idle: 'no_key' });
    expect(morningCalls()).toEqual([]);
    expect(await docsOf(p1.id)).toMatchObject([{ status: 'pending', attempts: 0 }]);
    expect(sendWithRetry.mock.calls.map((c) => c[0].to)).toEqual([EMAIL]);

    // The window shows it waits for Morning ("חשבונית ממתינה לחיבור מורנינג").
    const item = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [p1.id])).rows[0]!.id;
    const w = (await getChipOrderWindow(item))!;
    expect(w.documents_connected).toBe(false);
    expect(w.order.documents).toEqual([{
      kind: 'invoice', status: 'pending', amount: 3 * PRICE, number: null, url: null, last_error: null, numbers: [], email_status: null, email_to: null,
    }]);
    expect((await orderRow(p1.id)).invoice_number).toBeNull();
  });

  it('a key, but Morning cannot say whether the business is VAT-exempt → nothing is issued; the row keeps waiting, uncounted', async () => {
    morning.me = null; // /businesses/me is not answered
    morning.info = { vatRate: 0.18 }; // and documents/info does not say
    const r = await processDueDocuments();
    expect(r).toMatchObject({ claimed: 0, issued: 0, idle: 'no_document_type' });
    expect(sent.filter((s) => s.path === '/documents')).toEqual([]);
    expect(await docsOf(p1.id)).toMatchObject([{ status: 'pending', attempts: 0, claimed_at: null }]);
  });

  // ── Issued, once ─────────────────────────────────────────────────────────

  it('with a key: ONE POST /documents with the expected body; morning_docs stored and the number + link mirrored on the order; a second run issues nothing; the same charge again is still one row', async () => {
    const [row] = await docsOf(p1.id);
    const r = await processDueDocuments();
    expect(r.issued).toBeGreaterThanOrEqual(1);
    expect(r.idle).toBeNull();

    const posts = postsOf(row!.ref);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`${MORNING_API}/api/v1/documents`);
    expect(posts[0]!.auth).toBe(`Bearer docs-token-${RUN}`);
    expect(posts[0]!.body).toEqual({
      type: 320,
      lang: 'he',
      currency: 'ILS',
      vatType: 0,
      date: israelDate(),
      description: `כרטיסי בקרת כניסה — הזמנה ${p1.number} — דירה ${APT.web}`,
      remarks: `מזהה: ${row!.ref}`,
      client: { name: ORDERER, emails: [EMAIL], phone: '0539500071', address: 'הרצל 1', city: 'חיפה', zip: '3300000', country: 'IL', add: false },
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 3, price: PRICE, currency: 'ILS', vatType: 1 }],
      payment: [{ type: 3, date: row!.details.date, price: 3 * PRICE, currency: 'ILS', cardNum: '9844', cardType: 0, dealType: 1, numPayments: 1 }],
      signed: true,
      attachment: true,
      rounding: false,
    });
    // The token request carried the key in its body — and nothing else ever did.
    for (const s of morningCalls()) {
      expect(s.url).not.toContain(MORNING_KEY.secret);
      if (s.url !== MORNING_TOKEN) expect(JSON.stringify(s.body ?? null)).not.toContain(MORNING_KEY.secret);
    }

    const issued = await docRow(row!.id);
    const doc = issued.morning_docs[0]!;
    expect(issued).toMatchObject({ status: 'issued', attempts: 1, claimed_at: null, last_error: null });
    expect(issued.issued_at).not.toBeNull();
    expect(issued.morning_docs).toEqual([{ type: 320, id: expect.stringMatching(new RegExp(`^mdoc-${RUN}-\\d+$`)), number: expect.stringMatching(/^7\d{4}$/), url: expect.stringContaining('.pdf') }]);
    expect(await orderRow(p1.id)).toMatchObject({ invoice_number: doc.number, invoice_url: doc.url });
    const item = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [p1.id])).rows[0]!.id;
    const w = (await getChipOrderWindow(item))!;
    expect(w.documents_connected).toBe(true);
    // 27/11/2026: Morning was asked to email it — the order's email is on the request.
    expect(w.order.documents).toEqual([{
      kind: 'invoice', status: 'issued', amount: 3 * PRICE, number: doc.number, url: doc.url, last_error: null,
      numbers: [doc.number], email_status: 'sent', email_to: 'docs-test@example.test',
    }]);

    // Again: nothing more is sent, nothing changes.
    sent.length = 0;
    await processDueDocuments();
    expect(postsOf(row!.ref)).toEqual([]);
    expect(await docRow(row!.id)).toMatchObject({ status: 'issued', attempts: 1, morning_docs: [doc] });

    // PayPlus reports the same charge once more (the lookup this time): no second row.
    const again = await recordCardPayment({
      env: 'production', orderNumber: p1.number, transactionUid: p1Tx, pageRequestUid: (await pool.query(`select card_page_request_uid as u from public.chip_orders where id = $1`, [p1.id])).rows[0].u,
      amount: p1.total, approvalNumber: '0012345', last4: '9844',
    }, 'payplus_lookup');
    expect(again).toEqual({ kind: 'already_paid', orderId: p1.id });
    const c = await pool.connect();
    try {
      expect(await enqueueDocumentInTx(c, { orderId: p1.id, kind: 'invoice', paymentKey: `card:${p1Tx}`, amount: p1.total, method: 'card' })).toBeNull();
    } finally { c.release(); }
    expect(await docsOf(p1.id)).toHaveLength(1);
  });

  // ── Retries, failures, alerts ────────────────────────────────────────────

  it(`Morning 503: back to the queue with a backoff of 1, 5, 15, 60, 180 minutes; after ${MAX_DOCUMENT_ATTEMPTS} attempts the row fails and every active admin is alerted ONCE`, async () => {
    expect(MAX_DOCUMENT_ATTEMPTS).toBe(6);
    const o = await makeOrder({ isTest: false, chips: 2 });
    await payByCard(o, 'production');
    const [row] = await docsOf(o.id);
    morning.create = () => reply(503, { errorMessage: 'Service Unavailable' });

    const backoff = [1, 5, 15, 60, 180];
    for (let attempt = 1; attempt < MAX_DOCUMENT_ATTEMPTS; attempt++) {
      await processDueDocuments();
      const now = await docRow(row!.id);
      expect(now, `attempt ${attempt}`).toMatchObject({ status: 'pending', attempts: attempt, claimed_at: null, morning_docs: [] });
      expect(now.last_error).toContain('503');
      const ahead = await minutesAhead(row!.id);
      expect(ahead, `attempt ${attempt}`).toBeGreaterThan(backoff[attempt - 1]! - 0.5);
      expect(ahead, `attempt ${attempt}`).toBeLessThanOrEqual(backoff[attempt - 1]! + 0.05);
      // Not due yet: another run leaves it alone.
      const before = postsOf(row!.ref).length;
      await processDueDocuments();
      expect(postsOf(row!.ref)).toHaveLength(before);
      await makeDue(row!.id);
    }
    expect(await alertsOf(row!.id)).toEqual([]);

    await processDueDocuments();
    const failed = await docRow(row!.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: MAX_DOCUMENT_ATTEMPTS, claimed_at: null, issued_at: null });
    expect(failed.last_error).toContain('503');
    expect(postsOf(row!.ref)).toHaveLength(MAX_DOCUMENT_ATTEMPTS);

    const admins = await activeAdmins();
    expect(admins.length).toBeGreaterThanOrEqual(1);
    const alerts = await alertsOf(row!.id);
    expect(alerts.map((a) => a.user_id).sort()).toEqual(admins);
    for (const a of alerts) {
      expect(a).toMatchObject({ type: 'chip_order_alert', source_entity_id: o.id, priority: 'high' });
      expect(a.title).toContain(`הזמנה ${o.number}`);
      expect(a.title).toContain('חשבונית לא הופקה');
    }

    // A failed row is not due: another run sends nothing and alerts nobody again.
    await processDueDocuments();
    expect(postsOf(row!.ref)).toHaveLength(MAX_DOCUMENT_ATTEMPTS);
    expect(await alertsOf(row!.id)).toHaveLength(admins.length);
    expect((await orderRow(o.id)).invoice_number).toBeNull();
  });

  // Regression (25/11 night run): a timeout or a dropped connection can come
  // back AFTER Morning created the document. The row goes back to 'pending' (not
  // 'issuing'), so the next attempt must search Morning before it posts.
  it('Morning created the document but the answer never came back (network error): the retry finds it by its ref — no second POST /documents', async () => {
    const o = await makeOrder({ isTest: false, chips: 2 });
    await payByCard(o, 'production');
    const [row] = await docsOf(o.id);
    morning.create = (body) => {
      morning.search = [{
        id: `late-${RUN}`, number: 80200, type: 320, remarks: String(body.remarks ?? ''), amount: o.total,
        url: { origin: 'https://morning.example.test/late.pdf' },
      }];
      throw new TypeError('connection reset after Morning created the document');
    };

    await processDueDocuments();
    expect(postsOf(row!.ref)).toHaveLength(1);
    expect(await docRow(row!.id)).toMatchObject({ status: 'pending', attempts: 1, morning_docs: [] });

    morning.create = null;
    await makeDue(row!.id);
    await processDueDocuments();
    expect(postsOf(row!.ref)).toHaveLength(1);
    expect(searchesOf().length).toBeGreaterThanOrEqual(1);
    const adopted = await docRow(row!.id);
    expect(adopted).toMatchObject({ status: 'issued', attempts: 2, claimed_at: null });
    expect(adopted.morning_docs).toEqual([{ type: 320, id: `late-${RUN}`, number: '80200', url: 'https://morning.example.test/late.pdf' }]);
  });

  it('a refusal of the request itself (400) fails the row at once; "הפק חשבונית שוב" is admins\' only, puts it back, never alerts twice — and issues it once Morning accepts', async () => {
    const o = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(o, 'production');
    const [row] = await docsOf(o.id);
    morning.create = () => reply(400, { errorCode: 2403, errorMessage: 'סוג המסמך אינו זמין לעסק' });

    await processDueDocuments();
    const failed = await docRow(row!.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed.last_error).toBe('400 2403: סוג המסמך אינו זמין לעסק');
    const admins = await activeAdmins();
    expect(await alertsOf(row!.id)).toHaveLength(admins.length);

    // Not an admin: refused, nothing moves.
    as('manager');
    expect((await retry(o.id)).status).toBe(403);
    as(null);
    expect((await retry(o.id)).status).toBe(401);
    expect(await docRow(row!.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(afterQueue).toHaveLength(0);

    // An admin: back in the queue now, its attempts reset; the queue gets a turn after the answer.
    as('super');
    let res = await retry(o.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: 1 });
    expect(await docRow(row!.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await minutesAhead(row!.id)).toBeLessThanOrEqual(0);
    expect(afterQueue).toHaveLength(1);
    // Morning still refuses: failed again — and the admins are NOT alerted a second time.
    await runAfter();
    expect(await docRow(row!.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await alertsOf(row!.id)).toHaveLength(admins.length);
    expect(postsOf(row!.ref)).toHaveLength(2);

    // Morning accepts now.
    morning.create = null;
    res = await retry(o.id);
    expect(await res.json()).toEqual({ ok: true, queued: 1 });
    await runAfter();
    const issued = await docRow(row!.id);
    expect(issued).toMatchObject({ status: 'issued', attempts: 1, last_error: null });
    expect(postsOf(row!.ref)).toHaveLength(3);
    expect((await orderRow(o.id)).invoice_number).toBe(issued.morning_docs[0]!.number);
    const trail = (await pool.query(`select actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = 'documents_retry'`, [o.id])).rows;
    expect(trail).toEqual([{ actor_user_id: users.super!.id, metadata: { queued: 1 } }, { actor_user_id: users.super!.id, metadata: { queued: 1 } }]);

    // Nothing failed any more: a press queues nothing, and gives the queue no turn.
    res = await retry(o.id);
    expect(await res.json()).toEqual({ ok: true, queued: 0 });
    expect(afterQueue).toHaveLength(0);
    expect(postsOf(row!.ref)).toHaveLength(3);
    expect((await retry('not-a-uuid')).status).toBe(404);
  });

  // Regression (review, 26/11): "הפק חשבונית שוב" resets the attempts, yet the
  // failed attempt may have created the document (here a 2xx reply with no id
  // or number, which fails the row at once). The retried row must search
  // Morning BEFORE it posts — it carries the earlier attempt's error.
  it('a failed attempt that reached Morning (a 201 with no id / number): "הפק חשבונית שוב" searches FIRST and adopts the document by its ref — never a second POST /documents', async () => {
    const o = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(o, 'production');
    const [row] = await docsOf(o.id);
    morning.create = (body) => {
      morning.search = [{
        id: `unread-${RUN}`, number: 80300, type: 320, remarks: String(body.remarks ?? ''), amount: o.total,
        url: { origin: 'https://morning.example.test/unread.pdf' },
      }];
      return reply(201, { status: 'created' });
    };
    await processDueDocuments();
    const failed = await docRow(row!.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, morning_docs: [] });
    expect(failed.last_error).toContain('no document id');
    expect(postsOf(row!.ref)).toHaveLength(1);

    as('super');
    const res = await retry(o.id);
    expect(await res.json()).toEqual({ ok: true, queued: 1 });
    expect(await docRow(row!.id)).toMatchObject({ status: 'pending', attempts: 0 });
    morning.create = null;
    await runAfter();
    // Found by its ref — the retry posted nothing.
    expect(postsOf(row!.ref)).toHaveLength(1);
    expect(searchesOf().length).toBeGreaterThanOrEqual(1);
    const adopted = await docRow(row!.id);
    expect(adopted).toMatchObject({ status: 'issued', attempts: 1, last_error: null, claimed_at: null });
    expect(adopted.morning_docs).toEqual([{ type: 320, id: `unread-${RUN}`, number: '80300', url: 'https://morning.example.test/unread.pdf' }]);
    expect((await orderRow(o.id)).invoice_number).toBe('80300');
  });

  // ── Crash recovery ───────────────────────────────────────────────────────

  it('a row a crashed run left "issuing" 11 minutes ago is searched for in Morning FIRST: the document with its ref is adopted — no second POST /documents', async () => {
    const lost = await makeOrder({ isTest: false, chips: 2 });
    await payByCard(lost, 'production');
    const young = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(young, 'production');
    const [row] = await docsOf(lost.id);
    const [youngRow] = await docsOf(young.id);
    await pool.query(`update public.chip_order_documents set status = 'issuing', claimed_at = now() - interval '11 minutes', attempts = 1 where id = $1`, [row!.id]);
    // Another run's row, claimed 5 minutes ago: still that run's — not touched.
    await pool.query(`update public.chip_order_documents set status = 'issuing', claimed_at = now() - interval '5 minutes', attempts = 1 where id = $1`, [youngRow!.id]);
    morning.search = [
      { id: `decoy-${RUN}`, number: 80122, type: 320, remarks: 'מזהה: CHZZZZZZZZ', amount: lost.total, url: { origin: 'https://morning.example.test/decoy.pdf' } },
      { id: `lost-${RUN}`, number: 80123, type: 320, remarks: `מזהה: ${row!.ref}`, amount: lost.total, url: { origin: 'https://morning.example.test/lost.pdf' } },
    ];

    await processDueDocuments();
    expect(postsOf(row!.ref)).toEqual([]);
    expect(postsOf(youngRow!.ref)).toEqual([]);
    const searches = searchesOf();
    expect(searches).toHaveLength(1);
    const createdAt = (await pool.query(`select created_at from public.chip_order_documents where id = $1`, [row!.id])).rows[0].created_at as Date;
    expect(searches[0]!.body).toEqual({
      type: [320], fromDate: israelDate(new Date(createdAt.getTime() - 24 * 3600_000)), toDate: israelDate(), clientName: ORDERER, page: 1, pageSize: 100,
    });
    const adopted = await docRow(row!.id);
    expect(adopted).toMatchObject({ status: 'issued', attempts: 2, claimed_at: null });
    expect(adopted.morning_docs).toEqual([{ type: 320, id: `lost-${RUN}`, number: '80123', url: 'https://morning.example.test/lost.pdf' }]);
    expect(await orderRow(lost.id)).toMatchObject({ invoice_number: '80123', invoice_url: 'https://morning.example.test/lost.pdf' });
    expect(await docRow(youngRow!.id)).toMatchObject({ status: 'issuing', attempts: 1 });

    // Morning has nothing with the ref: the document is issued, once.
    sent.length = 0;
    morning.search = [{ id: `decoy2-${RUN}`, number: 80124, type: 320, remarks: 'מזהה: CHYYYYYYYY', url: {} }];
    await pool.query(`update public.chip_order_documents set claimed_at = now() - interval '11 minutes' where id = $1`, [youngRow!.id]);
    await processDueDocuments();
    expect(searchesOf()).toHaveLength(1);
    expect(postsOf(youngRow!.ref)).toHaveLength(1);
    expect(await docRow(youngRow!.id)).toMatchObject({ status: 'issued', attempts: 2 });
  });

  // ── The reception ────────────────────────────────────────────────────────

  let cashOrder: { id: string; order_number: number; total: number };

  it('reception: cash and a bank transfer store the method on the order and queue an invoice with THAT payment type (1 / 4); "ללא חיוב" queues nothing', async () => {
    const cash = await receptionSave('cash', 2);
    const transfer = await receptionSave('bank_transfer', 1);
    const none = await receptionSave('none', 1);
    expect(cash.order).toMatchObject({ method: 'cash', total: 2 * PRICE, chips: 2 });
    expect(transfer.order).toMatchObject({ method: 'bank_transfer', total: PRICE, chips: 1 });
    expect(none.order).toBeNull();
    expect(none.record).not.toBeNull();
    cashOrder = { id: cash.order!.id, order_number: cash.order!.order_number, total: cash.order!.total };

    expect(await orderRow(cash.order!.id)).toMatchObject({ source: 'reception', status: 'collected', payment_method: 'cash', is_test: false });
    expect(await orderRow(transfer.order!.id)).toMatchObject({ source: 'reception', status: 'collected', payment_method: 'bank_transfer' });
    const [cashRow] = await docsOf(cash.order!.id);
    const [transferRow] = await docsOf(transfer.order!.id);
    expect(await docsOf(cash.order!.id)).toHaveLength(1);
    expect(cashRow).toMatchObject({ kind: 'invoice', payment_key: `reception:${cash.order!.id}`, amount: 2 * PRICE, payment_method: 'cash', status: 'pending' });
    expect(transferRow).toMatchObject({ kind: 'invoice', payment_key: `reception:${transfer.order!.id}`, amount: PRICE, payment_method: 'bank_transfer', status: 'pending' });
    expect(cashRow!.details).toMatchObject({ recorded_by: 'e2e-admin', date: israelDate() });
    // No charge: no order of the contact beyond the two, so no third row.
    const all = (await pool.query(
      `select count(*)::int as n from public.chip_order_documents d join public.chip_order_items i on i.order_id = d.order_id where i.contact_id = $1`,
      [made.contacts[APT.reception]])).rows[0].n;
    expect(all).toBe(2);

    await processDueDocuments();
    const [cashPost] = postsOf(cashRow!.ref);
    const [transferPost] = postsOf(transferRow!.ref);
    expect(postsOf(cashRow!.ref)).toHaveLength(1);
    expect(postsOf(transferRow!.ref)).toHaveLength(1);
    expect(cashPost!.body).toMatchObject({
      type: 320,
      description: `כרטיסי בקרת כניסה — הזמנה ${cash.order!.order_number} — דירה ${APT.reception}`,
      client: { name: 'משלם בקבלה', country: 'IL', add: false },
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 2, price: PRICE, currency: 'ILS', vatType: 1 }],
      payment: [{ type: 1, date: israelDate(), price: 2 * PRICE, currency: 'ILS' }],
    });
    // A reception orderer with no details: the name only — no empty email or phone.
    expect(cashPost!.body!.client).toEqual({ name: 'משלם בקבלה', country: 'IL', add: false });
    expect(transferPost!.body).toMatchObject({ payment: [{ type: 4, date: israelDate(), price: PRICE, currency: 'ILS' }] });
    expect((cashPost!.body!.payment as Record<string, unknown>[])[0]).not.toHaveProperty('cardNum');
    expect(await docRow(cashRow!.id)).toMatchObject({ status: 'issued' });
    expect(await docRow(transferRow!.id)).toMatchObject({ status: 'issued' });
    expect((await orderRow(cash.order!.id)).invoice_number).toBe((await docRow(cashRow!.id)).morning_docs[0]!.number);
  });

  it('cancelling that cash order credits its issued invoice: a credit row (credit_of = the invoice) issued as a 330 AND a negative 400, linked "cancel"', async () => {
    const [invoice] = await docsOf(cashOrder.id);
    const original = invoice!.morning_docs[0]!;
    const done = await orders.cancelReceptionOrder(cashOrder.id, 'נרשם בטעות', admin);
    expect(done).toMatchObject({ payment_method: 'cash', card_paid: false, chips_disabled: 2 });
    const rows = await docsOf(cashOrder.id);
    expect(rows).toHaveLength(2);
    const credit = rows[1]!;
    expect(credit).toMatchObject({
      kind: 'credit', payment_key: `cancel:${cashOrder.id}`, credit_of: invoice!.id, amount: 2 * PRICE, payment_method: 'cash', status: 'pending',
    });

    await processDueDocuments();
    const posts = postsOf(credit.ref);
    expect(posts.map((p) => p.body!.type)).toEqual([330, 400]);
    const common = {
      linkedDocumentIds: [original.id], linkType: 'cancel', remarks: `מזהה: ${credit.ref}`,
      description: `זיכוי — כרטיסי בקרת כניסה — הזמנה ${cashOrder.order_number} — דירה ${APT.reception}`,
    };
    expect(posts[0]!.body).toMatchObject({ ...common, income: [{ description: 'כרטיס בקרת כניסה', quantity: 2, price: PRICE, currency: 'ILS', vatType: 1 }] });
    expect(posts[0]!.body).not.toHaveProperty('payment');
    expect(posts[1]!.body).toMatchObject({ ...common, income: [], payment: [{ type: 1, date: israelDate(), price: -2 * PRICE, currency: 'ILS' }] });
    const issued = await docRow(credit.id);
    expect(issued.status).toBe('issued');
    expect(issued.morning_docs.map((m) => m.type)).toEqual([330, 400]);
    // The order keeps the number of its invoice — a credit is never mirrored.
    expect((await orderRow(cashOrder.id)).invoice_number).toBe(original.number);
  });

  it('an EXEMPT business: the invoice is a 400 (no VAT), and its cancellation is credited by ONE negative 400 with negative income', async () => {
    morning.me = { type: 3, exemption: true };
    morning.info = { exemption: true, vatRate: 0 };
    const save = await receptionSave('cash', 1);
    const [invoice] = await docsOf(save.order!.id);
    await processDueDocuments();
    const [post] = postsOf(invoice!.ref);
    expect(post!.body).toMatchObject({
      type: 400, income: [{ description: 'כרטיס בקרת כניסה', quantity: 1, price: PRICE, currency: 'ILS', vatType: 0 }],
      payment: [{ type: 1, price: PRICE }],
    });
    const original = (await docRow(invoice!.id)).morning_docs[0]!;
    expect(original.type).toBe(400);

    await orders.cancelReceptionOrder(save.order!.id, 'בוטל בקבלה', admin);
    const credit = (await docsOf(save.order!.id))[1]!;
    expect(credit).toMatchObject({ kind: 'credit', credit_of: invoice!.id, payment_method: 'cash' });
    await processDueDocuments();
    const posts = postsOf(credit.ref);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      type: 400, linkedDocumentIds: [original.id], linkType: 'cancel',
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 1, price: -PRICE, currency: 'ILS', vatType: 0 }],
      payment: [{ type: 1, price: -PRICE, currency: 'ILS' }],
    });
    expect(await docRow(credit.id)).toMatchObject({ status: 'issued' });
  });

  it('a credit waits for its original (postponed, its attempt not counted); with the original failed, it fails for a person', async () => {
    const save = await receptionSave('bank_transfer', 1);
    const [invoice] = await docsOf(save.order!.id);
    // The invoice is not issued yet (rescheduled for later).
    await pool.query(`update public.chip_order_documents set next_attempt_at = now() + interval '1 hour' where id = $1`, [invoice!.id]);
    await orders.cancelReceptionOrder(save.order!.id, 'בוטל לפני החשבונית', admin);
    const credit = (await docsOf(save.order!.id))[1]!;
    expect(credit).toMatchObject({ kind: 'credit', credit_of: invoice!.id, payment_method: 'bank_transfer' });

    const r = await processDueDocuments();
    expect(r.postponed).toBeGreaterThanOrEqual(1);
    expect(postsOf(credit.ref)).toEqual([]);
    expect(await docRow(credit.id)).toMatchObject({ status: 'pending', attempts: 0 });
    const ahead = await minutesAhead(credit.id);
    expect(ahead).toBeGreaterThan(9.5);
    expect(ahead).toBeLessThanOrEqual(10.05);

    // The original failed for good: the credit cannot be issued against it.
    await pool.query(`update public.chip_order_documents set status = 'failed', last_error = 'test' where id = $1`, [invoice!.id]);
    await makeDue(credit.id);
    await processDueDocuments();
    const failed = await docRow(credit.id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toContain('אין מסמך מקורי');
    expect(postsOf(credit.ref)).toEqual([]);
    const alerts = await alertsOf(credit.id);
    expect(alerts).toHaveLength((await activeAdmins()).length);
    expect(alerts[0]!.title).toContain('מסמך זיכוי לא הופק');
  });

  it('a credit of a 320 whose 330 was issued before its negative 400 failed: the retry issues ONLY the 400 — the 330 is never sent twice', async () => {
    const save = await receptionSave('cash', 1);
    const [invoice] = await docsOf(save.order!.id);
    await processDueDocuments();
    expect((await docRow(invoice!.id)).morning_docs[0]!.type).toBe(320);
    await orders.cancelReceptionOrder(save.order!.id, 'בוטל בקבלה', admin);
    const credit = (await docsOf(save.order!.id))[1]!;

    // Morning issues the 330, then fails on the receipt.
    morning.create = (body) => (body.type === 400 ? reply(503, { errorMessage: 'Service Unavailable' }) : null);
    await processDueDocuments();
    let row = await docRow(credit.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row.last_error).toContain('503');
    expect(row.morning_docs.map((m) => m.type)).toEqual([330]);
    expect(postsOf(credit.ref).map((p) => p.body!.type)).toEqual([330, 400]);

    morning.create = null;
    await makeDue(credit.id);
    await processDueDocuments();
    row = await docRow(credit.id);
    expect(row).toMatchObject({ status: 'issued', attempts: 2 });
    expect(row.morning_docs.map((m) => m.type)).toEqual([330, 400]);
    // One 330 in all: the second run sent the receipt only.
    expect(postsOf(credit.ref).map((p) => p.body!.type)).toEqual([330, 400, 400]);
  });

  it('EXTRA chips of a paid web order settled in cash at its window: a reception order of their own, with its invoice row (method cash) — issued with the orderer of the web order', async () => {
    const web = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(web, 'production');
    const holder = (await pool.query<{ id: string; item_id: string }>(`select id, item_id from public.chip_order_holders where order_id = $1`, [web.id])).rows[0]!;
    chipSeq += 2;
    const result = await saveChipOrderWindow(web.id, {
      holders: [{
        id: holder.id, item_id: holder.item_id, role: 'owner', full_name: ORDERER, phone: '0539500071', email: null,
        new_chips: [{ number: `D${tag}${chipSeq - 1}`, chip_type: 'physical' }, { number: `D${tag}${chipSeq}`, chip_type: 'physical' }],
      }],
      extraPayment: { method: 'cash', amount: PRICE },
    }, admin, PRICE);
    expect(result!.extra).toMatchObject({ chips: 1, method: 'cash', order: { total: PRICE } });
    const extraId = result!.extra!.order!.id;
    expect(await orderRow(extraId)).toMatchObject({ source: 'reception', payment_method: 'cash', status: 'collected' });
    const rows = await docsOf(extraId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'invoice', payment_key: `reception:${extraId}`, amount: PRICE, payment_method: 'cash', status: 'pending' });
    expect(rows[0]!.details).toMatchObject({ extra_of_order: web.number, recorded_by: 'e2e-admin' });
    // The web order's own invoice (its card charge) is untouched — still one row.
    expect(await docsOf(web.id)).toHaveLength(1);

    await processDueDocuments();
    const [post] = postsOf(rows[0]!.ref);
    expect(post!.body).toMatchObject({
      type: 320,
      description: `כרטיסי בקרת כניסה — הזמנה ${result!.extra!.order!.order_number} — דירה ${APT.web}`,
      client: { name: ORDERER, emails: [EMAIL], phone: '0539500071', address: 'הרצל 1', city: 'חיפה', zip: '3300000' },
      income: [{ description: 'כרטיס בקרת כניסה', quantity: 1, price: PRICE, currency: 'ILS', vatType: 1 }],
      payment: [{ type: 1, price: PRICE, currency: 'ILS' }],
    });
    expect(await docRow(rows[0]!.id)).toMatchObject({ status: 'issued' });
  });

  // Regression (found 25/11 night run): a run claims up to 10 rows at once and
  // issues them one by one, while another run may take over a claim older than
  // 10 minutes. renewDocumentClaim re-checks (and re-stamps) the claim right
  // before each row, so the slow run skips a row it lost. Simulated by ageing
  // the claim of the run's second row while the run waits on Morning.
  it('a run that still holds a row after its 10-minute claim aged out does NOT issue it a second time', async () => {
    const x = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(x, 'production');
    const y = await makeOrder({ isTest: false, chips: 1 });
    await payByCard(y, 'production');
    const [rx] = await docsOf(x.id);
    const [ry] = await docsOf(y.id);
    let reached!: () => void;
    const atMorning = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    morning.hold = { ref: null, reached, release: new Promise<void>((r) => { release = r; }) };

    const runA = processDueDocuments(); // claims BOTH rows, then waits on Morning for its first
    let other: DocRow;
    try {
      await atMorning;
      other = morning.hold.ref === rx!.ref ? ry! : rx!;
      expect(await docRow(other.id)).toMatchObject({ status: 'issuing' });
      // Ten minutes pass for the claim of the row run A has not reached yet.
      await pool.query(`update public.chip_order_documents set claimed_at = now() - interval '11 minutes' where id = $1`, [other.id]);
      await processDueDocuments(); // run B: the row looks abandoned — searched (nothing), issued
      expect(postsOf(other.ref)).toHaveLength(1);
      expect(await docRow(other.id)).toMatchObject({ status: 'issued' });
    } finally {
      release();
      await runA;
    }
    // Run A reaches the row it still holds in memory …and must not send it again.
    expect(postsOf(other.ref)).toHaveLength(1);
  });

  it('no request of this file ever left for anywhere but the Morning stub', () => {
    expect(elsewhere).toEqual([]);
  });
});

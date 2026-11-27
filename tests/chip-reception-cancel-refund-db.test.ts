import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// "ביטול וזיכוי" of a paid reception order, and the email of its Morning
// documents (27/11/2026 — what the first real ₪1 charge of 26/11/2026 showed),
// against a throwaway database (WA_TEST_DATABASE_URL), never prod:
//   - the invoice of a card paid in the reception window waits for the
//     window's "שמור" (which completes the orderer), and is issued with
//     client.emails = [the orderer's email]; an order with no email is issued
//     without one and says so (email_status 'no_email');
//   - "ביטול וזיכוי" runs IN THIS ORDER: PayPlus is asked whether the charge
//     is still there (Transactions/View), the refund (one call), the Morning
//     credit (330 + a negative 400, emailed to the orderer), then the order
//     cancelled and its chips disabled (never deleted);
//   - PayPlus already shows the charge CANCELLED (a refund made in its
//     dashboard): no refund is sent; it is recorded as made "בממשק PayPlus",
//     with a note, and the rest runs;
//   - a step that fails stops the run there and the order says which; a
//     retry runs the remaining steps only — a refund is never sent twice,
//     also when its answer never came;
//   - admin and super admin only.
// PayPlus and Morning are stubs that answer by URL; anything else is refused.
// Rows are removed by the exact ids made here.

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
const createNotification = vi.fn<(n: { type: string; dedupeKey?: string }) => Promise<undefined>>(async () => undefined);
vi.mock('@/services/notifications', async (orig) => ({
  ...(await orig<typeof import('@/services/notifications')>()),
  createNotification,
}));
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
const PRICE = 1;
const APP_URL = 'https://chips.example.test';
const PROD = { api: 'prod-api-key-cancel-test', secret: 'prod-secret-key-cancel-test', page: '99999999-8888-7777-6666-555555555544' };
const PAYPLUS = 'https://restapi.payplus.co.il';
const MORNING_TOKEN = 'https://api.morning.co/idp/v1/oauth/token';
const MORNING_API = 'https://api.greeninvoice.co.il/api/v1';
const APT = `984${tag}1`;
const EMAIL = 'orderer-cancel@example.test';

const { NextRequest } = await import('next/server');
const { POST: cardRoute } = await import('@/app/api/chips/reception/card/route');
const { POST: chipsRoute } = await import('@/app/api/chips/route');
const cancelRoute = await import('@/app/api/chip-orders/[id]/cancel/route');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const { __resetMorningTokenForTests } = await import('@/lib/morning/client');
const { __resetMorningProfileForTests } = await import('@/lib/chipOrders/documents');

const made = { contact: '', users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: string }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
const saved = { hadSettings: false, settings: null as unknown };

// ── PayPlus and Morning, as stubs that answer by URL ────────────────────────

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call { host: 'payplus' | 'morning'; path: string; body: Record<string, unknown> }
const calls: Call[] = [];
const elsewhere: string[] = [];
let generatedSeq = 0;
let refundSeq = 0;
let morningSeq = 0;
/** What PayPlus answers — set per test. */
const pp = {
  /** Charges PayPlus shows as cancelled (transaction_is_cancelled). */
  cancelled: new Set<string>(),
  /** Refund transactions Transactions/View finds by more_info. */
  refundsByMoreInfo: new Map<string, { uid: string; amount: number }[]>(),
  /** Transactions/View does not answer (HTTP 500). */
  viewDown: false,
  /** The refund call: 'ok' | 'refused' | 'no_answer'. */
  refund: 'ok' as 'ok' | 'refused' | 'no_answer',
  /** Refunds PayPlus links to a payment session (PaymentPages/ipn, related transactions). */
  relatedBySession: new Map<string, { uid: string; amount: number; more_info: string }[]>(),
};
/** Morning refuses POST /documents (422) while true. */
let morningRefuses = false;
const morningDocs: { type: number; emails: unknown; client: Record<string, unknown>; linked: unknown }[] = [];

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  if (url.href === MORNING_TOKEN) {
    calls.push({ host: 'morning', path: 'token', body: {} });
    return reply(200, { accessToken: 'morning-test-token', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.href.startsWith(MORNING_API)) {
    const path = url.href.slice(MORNING_API.length);
    calls.push({ host: 'morning', path, body });
    if (path === '/businesses/me') return reply(200, { type: 2, exemption: false, name: 'בניין בדיקה' });
    if (path === '/documents/info?type=320') return reply(200, { exemption: false, vatRate: 0.18 });
    if (path === '/documents/types?lang=he') return reply(200, [{ id: 320 }, { id: 330 }, { id: 400 }]);
    if (path === '/documents/search') return reply(200, { items: [] });
    if (path === '/documents' && init?.method === 'POST') {
      if (morningRefuses) return reply(422, { errorCode: 1110, errorMessage: 'מורנינג סירב בבדיקה' });
      morningSeq += 1;
      const client = (body.client ?? {}) as Record<string, unknown>;
      morningDocs.push({ type: Number(body.type), emails: client.emails, client, linked: body.linkedDocumentIds });
      return reply(200, { id: randomUUID(), number: 50000 + morningSeq, type: body.type, url: { origin: `https://docs.example.test/${morningSeq}` } });
    }
    return reply(404, { errorMessage: `no stub for ${path}` });
  }
  if (url.origin !== PAYPLUS) {
    elsewhere.push(url.href);
    throw new TypeError(`no network in this test: ${url.href}`);
  }
  calls.push({ host: 'payplus', path: url.pathname.replace('/api/v1.0/', ''), body });
  if (url.pathname === '/api/v1.0/PaymentPages/generateLink') {
    generatedSeq += 1;
    const n = String(generatedSeq).padStart(12, '0');
    return reply(200, { results: { status: 'success', code: 0 }, data: { page_request_uid: `${RUN}-c3c3-4c3c-8c3c-${n}`, hosted_fields_uuid: `${RUN}-f3f3-4f3f-8f3f-${n}` } });
  }
  if (url.pathname === '/api/v1.0/PaymentPages/ipn') {
    // The session's charge (flat), with what PayPlus links to it.
    const pru = String(body.payment_request_uid);
    const related = pp.relatedBySession.get(pru) ?? [];
    return reply(200, {
      results: { status: 'success', code: 0, description: 'operation has been success' },
      data: {
        transaction_uid: `charge-of-${pru}`, page_request_uid: pru, type: 'Charge', status_code: '000', amount: PRICE, currency: 'ILS',
        related_transactions: related.map((r) => ({ transaction_uid: r.uid, type: 'Refund', status_code: '000', amount: r.amount, currency: 'ILS', more_info: r.more_info })),
      },
    });
  }
  if (url.pathname === '/api/v1.0/Transactions/View') {
    if (pp.viewDown) return reply(500, { message: 'down in this test' });
    if (typeof body.transaction_uid === 'string') {
      const uid = body.transaction_uid;
      return reply(200, {
        results: { status: 'success', code: 0, description: 'operation has been success' },
        data: [{ transaction: { transaction_uid: uid, transaction_type: 'Charge', status_code: '000', transaction_is_cancelled: pp.cancelled.has(uid), amount: PRICE, more_info: 'x' }, data: {} }],
      });
    }
    const mi = String(body.more_info);
    const list = pp.refundsByMoreInfo.get(mi) ?? [];
    if (list.length === 0) return reply(200, { results: { status: 'error', code: 1, description: 'no transactions' }, data: {} });
    return reply(200, {
      results: { status: 'success', code: 0, description: 'operation has been success' },
      data: list.map((r) => ({ transaction: { transaction_uid: r.uid, transaction_type: 'Refund', status_code: '000', transaction_is_cancelled: false, amount: r.amount, more_info: mi }, data: {} })),
    });
  }
  if (url.pathname === '/api/v1.0/Transactions/RefundByTransactionUID') {
    if (pp.refund === 'no_answer') throw new TypeError('fetch failed');
    if (pp.refund === 'refused') {
      return reply(200, { results: { status: 'error', code: 1, description: 'הזיכוי נדחה על ידי חברת האשראי' }, data: { transaction: { status_code: '004' } } });
    }
    refundSeq += 1;
    return reply(200, {
      results: { status: 'success', code: 0 },
      data: { transaction: { uid: `rf-${RUN}-cx-${refundSeq}`, status_code: '000', amount: body.amount, currency: 'ILS', approval_number: '0555111' } },
    });
  }
  throw new Error(`unexpected PayPlus path in a test: ${url.pathname}`);
});
const payplus = (path: string) => calls.filter((c) => c.host === 'payplus' && c.path === path);
const refundCalls = () => payplus('Transactions/RefundByTransactionUID').length;

// ── Requests ────────────────────────────────────────────────────────────────

const json = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const sign = (body: string) => createHmac('sha256', PROD.secret).update(body).digest('base64');
function callback(payload: unknown) {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request('http://localhost/api/public/chip-order/payplus/callback?env=production', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body) }, body,
  }));
}
const cancel = (orderId: string, body: Record<string, unknown>) =>
  cancelRoute.POST(json(`/api/chip-orders/${orderId}/cancel`, body), { params: Promise.resolve({ id: orderId }) });
const preview = (orderId: string) =>
  cancelRoute.GET(new Request(`http://localhost/api/chip-orders/${orderId}/cancel`), { params: Promise.resolve({ id: orderId }) });
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };
let chipSeq = 0;

interface Live { id: string; orderNumber: number; token: string; tx: string; chips: string[] }
const orderIds = new Set<string>();

/** A REAL reception order: the window's card session, PayPlus's signed charge
 *  (production), then the window's save of `chips` new chips for one guest. */
async function liveCollectedOrder(opts: { chips?: number; email?: string | null; save?: boolean } = {}): Promise<Live> {
  const n = opts.chips ?? 1;
  const email = opts.email === undefined ? EMAIL : opts.email;
  const orderer = { name: 'רונן בדיקה', phone: '0539500074', email: null, street: null, city: null, zip: null };
  // The card session is opened before the email is typed (the 26/11 case).
  const res = await cardRoute(json('/api/chips/reception/card', { contact_id: made.contact, new_chips: n, test: false, role: 'other', orderer }));
  expect(res.status).toBe(200);
  const o = (await res.json()) as { token: string; order_number: number; order_id: string; session: { page_request_uid: string } };
  orderIds.add(o.order_id);
  const tx = `tx-${RUN}-cx-${o.order_number}`;
  expect((await callback({
    transaction_type: 'Charge',
    transaction: {
      uid: tx, payment_request_uid: o.session.page_request_uid, type: 'internal_page', status_code: '000', amount: n * PRICE, currency: 'ILS',
      payments: { number_of_payments: 1 }, approval_number: '0125518', more_info: String(o.order_number),
    },
    data: { card_information: { four_digits: '1334' } },
  })).status).toBe(200);
  await runAfter();
  const numbers = Array.from({ length: n }, () => { chipSeq += 1; return `X${tag}${chipSeq}`; });
  if (opts.save !== false) {
    const saveRes = await chipsRoute(json('/api/chips', {
      contact_id: made.contact,
      groups: [{ resident_role: 'other', holder_name: 'אורח בדיקה', chip_type: 'physical', numbers, block: 0 }],
      orderer: { ...orderer, name: 'רונן בדיקה - בדיקה', email },
      payment: { method: 'card', amount: n * PRICE, card_token: o.token },
    }));
    expect(saveRes.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    await runAfter();
  }
  return { id: o.order_id, orderNumber: o.order_number, token: o.token, tx, chips: numbers };
}

const orderOf = async (id: string) => (await pool.query<{
  status: string; refund_status: string | null; refund_via: string | null; refunded_amount: number | null; refund_note: string | null;
  refund_requested_at: Date | null; cancel_failed_step: string | null; cancel_error: string | null; cancel_requested_at: Date | null;
  cancelled_by: string | null; reject_reason: string | null; refund_transaction_uid: string | null;
}>(
  `select status, refund_status, refund_via, refunded_amount::float8 as refunded_amount, refund_note, refund_requested_at,
          cancel_failed_step, cancel_error, cancel_requested_at, cancelled_by, reject_reason, refund_transaction_uid
     from public.chip_orders where id = $1`, [id],
)).rows[0]!;
const docsOf = async (id: string) => (await pool.query<{
  kind: string; status: string; payment_key: string; email_status: string | null; email_to: string | null; numbers: string[]; next_due: boolean;
}>(
  `select kind, status, payment_key, email_status, email_to,
          coalesce((select array_agg(x->>'number') from jsonb_array_elements(morning_docs) x), '{}') as numbers,
          (next_attempt_at <= now()) as next_due
     from public.chip_order_documents where order_id = $1 order by created_at`, [id],
)).rows;
const chipStates = async (id: string) => (await pool.query<{ status: string }>(
  `select c.status from public.chips c join public.chip_order_items i on i.id = c.order_item_id where i.order_id = $1 order by c.chip_number`, [id],
)).rows.map((r) => r.status);
const audit = async (id: string, action: string) => (await pool.query<{ metadata: Record<string, unknown> }>(
  `select metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2 order by created_at`, [id, action],
)).rows.map((r) => r.metadata);

d('"ביטול וזיכוי" of a reception order, and the email of its Morning documents', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    const username = `cxl-mgr-${tag}`;
    const m = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', 'מנהל ביטול', 'manager', true) returning id`,
      [username, `${username}@example.test`],
    );
    made.users.push(m.rows[0]!.id);
    users.manager = { id: m.rows[0]!.id, username, email: null, full_name: 'מנהל ביטול', role: 'manager' };
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager.id, mod]);
    }
    made.contact = (await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539500074') returning id`, [APT],
    )).rows[0]!.id;
    const s = await pool.query(`select value from public.app_settings where key = 'chip_orders'`);
    saved.hadSettings = (s.rowCount ?? 0) > 0;
    saved.settings = s.rows[0]?.value ?? null;
    await pool.query(
      `insert into public.app_settings (key, value) values ('chip_orders', $1::jsonb)
       on conflict (key) do update set value = public.app_settings.value || excluded.value`,
      [JSON.stringify({ unitPrice: PRICE })],
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    for (const id of (await pool.query<{ id: string }>(
      `select distinct o.id from public.chip_orders o join public.chip_order_items i on i.order_id = o.id where i.contact_id = $1`, [made.contact],
    )).rows.map((r) => r.id)) orderIds.add(id);
    const ids = [...orderIds];
    for (const { id } of (await pool.query<{ id: string }>(`select id from public.chips where contact_id = $1`, [made.contact])).rows) {
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
    await pool.query(`delete from public.contacts where id = $1`, [made.contact]);
    for (const id of made.users) {
      await pool.query(`delete from public.user_permissions where user_id = $1`, [id]);
      await pool.query(`delete from public.users where id = $1`, [id]);
    }
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-session:user:${users.super!.id}`]);
    if (saved.hadSettings) await pool.query(`update public.app_settings set value = $1::jsonb where key = 'chip_orders'`, [JSON.stringify(saved.settings)]);
    else await pool.query(`delete from public.app_settings where key = 'chip_orders'`);
    await pool.end();
  });

  beforeEach(async () => {
    for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
    Object.assign(fakeEnv, {
      APP_URL,
      PAYPLUS_MODE: 'production', PAYPLUS_LIVE_CHARGING: 'on',
      PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page,
      MORNING_API_KEY_ID: 'morning-test-id', MORNING_API_KEY_SECRET: 'morning-test-secret',
    });
    __resetMorningTokenForTests();
    __resetMorningProfileForTests();
    calls.length = 0;
    morningDocs.length = 0;
    pp.cancelled.clear();
    pp.refundsByMoreInfo.clear();
    pp.relatedBySession.clear();
    pp.viewDown = false;
    pp.refund = 'ok';
    morningRefuses = false;
    afterQueue.length = 0;
    await pool.query(`delete from public.auth_rate_limits where bucket = $1`, [`chip-reception:card-session:user:${users.super!.id}`]);
    as('super');
  });

  // ── 2.1 — the email of the documents ─────────────────────────────────────

  it('the invoice of a reception card payment waits for the window\'s save, then goes to Morning with the orderer\'s email (typed after the card session opened)', async () => {
    const o = await liveCollectedOrder({ save: false });
    let docs = await docsOf(o.id);
    expect(docs).toEqual([expect.objectContaining({ kind: 'invoice', status: 'pending', next_due: false })]);
    expect(morningDocs).toEqual([]);
    // The save completes the orderer and releases the invoice.
    const saveRes = await chipsRoute(json('/api/chips', {
      contact_id: made.contact,
      groups: [{ resident_role: 'other', holder_name: 'אורח בדיקה', chip_type: 'physical', numbers: [`X${tag}w1`], block: 0 }],
      orderer: { name: 'רונן בדיקה - בדיקה', phone: '0539500074', email: EMAIL, street: null, city: null, zip: null },
      payment: { method: 'card', amount: PRICE, card_token: o.token },
    }));
    expect(saveRes.status).toBe(201);
    await new Promise((r) => setTimeout(r, 30));
    expect((await docsOf(o.id))[0]).toMatchObject({ status: 'pending', next_due: true });
    await runAfter();
    docs = await docsOf(o.id);
    expect(docs[0]).toMatchObject({ kind: 'invoice', status: 'issued', email_status: 'sent', email_to: EMAIL });
    expect(morningDocs).toHaveLength(1);
    expect(morningDocs[0]).toMatchObject({ type: 320, emails: [EMAIL] });
    expect(morningDocs[0]!.client.name).toBe('רונן בדיקה - בדיקה');
  });

  it('an order with no email: the invoice is issued without one, silently, and the order says so', async () => {
    const o = await liveCollectedOrder({ email: null });
    const docs = await docsOf(o.id);
    expect(docs[0]).toMatchObject({ kind: 'invoice', status: 'issued', email_status: 'no_email', email_to: null });
    expect(morningDocs[0]!.emails).toBeUndefined();
  });

  // ── 2.2 — the steps, in order ────────────────────────────────────────────

  it('admins only: a manager gets 403 on the preview and the action — nothing changes, nothing is called', async () => {
    const o = await liveCollectedOrder();
    calls.length = 0;
    as('manager');
    expect((await preview(o.id)).status).toBe(403);
    expect((await cancel(o.id, { reason: 'ניסיון של מנהל' })).status).toBe(403);
    as(null);
    expect((await cancel(o.id, { reason: 'ניסיון' })).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await orderOf(o.id)).status).toBe('collected');
  });

  it('the preview states the amount, the card, the email of the credit, and every chip the cancellation disables', async () => {
    const o = await liveCollectedOrder({ chips: 2 });
    const res = await preview(o.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      order_number: o.orderNumber, amount: 2 * PRICE, payment_method: 'card', card: { last4: '1334', env: 'production' },
      email: EMAIL, has_invoice: true, chips: o.chips, requested_at: null, failed_step: null, cancellable: true,
    });
    // A reason is required the first time.
    const noReason = await cancel(o.id, {});
    expect(noReason.status).toBe(400);
    expect(refundCalls()).toBe(0);
  });

  it('in order: PayPlus is asked first, ONE refund, the credit (330 + 400) to the orderer\'s email, then the order cancelled and its chips disabled', async () => {
    const o = await liveCollectedOrder({ chips: 2 });
    calls.length = 0;
    morningDocs.length = 0;
    const res = await cancel(o.id, { reason: 'החזרת התשלום' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, failed_step: null, refund: 'refunded', chips_disabled: 2, credit_email: { status: 'sent', to: EMAIL } });
    expect(body.credit_numbers).toHaveLength(2);
    // The order of the calls: the charge looked at, then the refund, then Morning.
    const order = calls.filter((c) => c.path !== 'token' && !c.path.startsWith('/businesses') && !c.path.startsWith('/documents/info') && !c.path.startsWith('/documents/types'))
      .map((c) => `${c.host}:${c.path}`);
    expect(order).toEqual([
      'payplus:Transactions/View', 'payplus:Transactions/View', 'payplus:Transactions/View', 'payplus:PaymentPages/ipn',
      'payplus:Transactions/RefundByTransactionUID', 'morning:/documents', 'morning:/documents',
    ]);
    expect(payplus('Transactions/RefundByTransactionUID')[0]!.body).toEqual({ transaction_uid: o.tx, amount: 2 * PRICE, more_info: `refund:${o.orderNumber}`, initial_invoice: false });
    expect(morningDocs.map((m) => [m.type, m.emails])).toEqual([[330, [EMAIL]], [400, [EMAIL]]]);
    const row = await orderOf(o.id);
    expect(row).toMatchObject({
      status: 'rejected', refund_status: 'refunded', refund_via: 'reception_cancel', refunded_amount: 2 * PRICE,
      cancel_failed_step: null, cancel_error: null, cancelled_by: users.super!.id, reject_reason: 'החזרת התשלום',
    });
    expect(await chipStates(o.id)).toEqual(['inactive', 'inactive']);
    const credit = (await docsOf(o.id)).find((x) => x.kind === 'credit')!;
    expect(credit).toMatchObject({ status: 'issued', email_status: 'sent', email_to: EMAIL });
    expect((await audit(o.id, 'reception_cancelled'))[0]).toMatchObject({ chips_disabled: 2, steps: { refund: 'refunded' } });
    // Done once: again → 409, and no second refund.
    expect((await cancel(o.id, { reason: 'שוב' })).status).toBe(409);
    expect(refundCalls()).toBe(1);
  });

  // ── 2.3 — the refund was made in PayPlus directly ───────────────────────

  it('PayPlus already shows the charge CANCELLED (the dashboard): no refund is sent; recorded "בממשק PayPlus" with a note; the credit and the cancellation follow', async () => {
    const o = await liveCollectedOrder();
    pp.cancelled.add(o.tx);
    calls.length = 0;
    morningDocs.length = 0; // the invoice, issued with the save
    const res = await cancel(o.id, { reason: 'זוכה בממשק PayPlus' });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, refund: 'outside', chips_disabled: 1 });
    expect(refundCalls()).toBe(0);
    const row = await orderOf(o.id);
    expect(row).toMatchObject({ status: 'rejected', refund_status: 'refunded', refund_via: 'payplus', refunded_amount: PRICE });
    expect(row.refund_note).toContain('בממשק PayPlus');
    expect(row.refund_transaction_uid).toBe(`cancelled:${o.tx}`);
    expect(await chipStates(o.id)).toEqual(['inactive']);
    expect(morningDocs.map((m) => m.type)).toEqual([330, 400]);
    expect((await audit(o.id, 'refunded'))[0]).toMatchObject({ via: 'payplus', note: expect.stringContaining('בממשק PayPlus') });
  });

  it('PayPlus already holds a full REFUND of the order (more_info): no refund is sent, that refund is recorded', async () => {
    const o = await liveCollectedOrder();
    pp.refundsByMoreInfo.set(String(o.orderNumber), [{ uid: `dash-${RUN}-1`, amount: PRICE }]);
    const body = await (await cancel(o.id, { reason: 'זוכה בממשק' })).json();
    expect(body).toMatchObject({ ok: true, refund: 'outside' });
    expect(refundCalls()).toBe(0);
    expect(await orderOf(o.id)).toMatchObject({ status: 'rejected', refund_via: 'payplus', refund_transaction_uid: `dash-${RUN}-1` });
  });

  // ── A step fails; the retry runs the rest only ───────────────────────────

  it('PayPlus cannot be asked: it stops at the refund step with NOTHING sent; the retry (no reason needed) goes on', async () => {
    const o = await liveCollectedOrder();
    pp.viewDown = true;
    let body = await (await cancel(o.id, { reason: 'בדיקת תקלה' })).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(refundCalls()).toBe(0);
    expect(await orderOf(o.id)).toMatchObject({ status: 'collected', cancel_failed_step: 'refund' });
    expect(await chipStates(o.id)).toEqual(['active']);
    const p = await (await preview(o.id)).json();
    expect(p).toMatchObject({ failed_step: 'refund', reason: 'בדיקת תקלה' });
    pp.viewDown = false;
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: true, refund: 'refunded' });
    expect(refundCalls()).toBe(1);
    expect(await orderOf(o.id)).toMatchObject({ status: 'rejected', reject_reason: 'בדיקת תקלה', cancel_failed_step: null });
  });

  it('PayPlus REFUSES the refund: it stops there (the order and its chips untouched); the retry refunds and finishes', async () => {
    const o = await liveCollectedOrder();
    pp.refund = 'refused';
    let body = await (await cancel(o.id, { reason: 'סירוב' })).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(body.message).toContain('PayPlus סירב לזיכוי');
    expect(await orderOf(o.id)).toMatchObject({ status: 'collected', refund_status: 'manual_required', refund_requested_at: null });
    expect(await chipStates(o.id)).toEqual(['active']);
    expect((await docsOf(o.id)).some((x) => x.kind === 'credit')).toBe(false);
    pp.refund = 'ok';
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: true, refund: 'refunded' });
    expect(refundCalls()).toBe(2); // the refused one, and the one that went through
  });

  it('a refund whose answer NEVER CAME is never sent again: the retry only asks PayPlus — and goes on once PayPlus shows it', async () => {
    const o = await liveCollectedOrder();
    pp.refund = 'no_answer';
    let body = await (await cancel(o.id, { reason: 'בלי תשובה' })).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(refundCalls()).toBe(1);
    expect((await orderOf(o.id)).refund_requested_at).not.toBeNull();
    // Older than the call itself; PayPlus shows nothing returned → still stopped, NO second call.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '5 minutes' where id = $1`, [o.id]);
    pp.refund = 'ok';
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(body.message).toContain('לא נשלח זיכוי נוסף');
    expect(refundCalls()).toBe(1);
    // PayPlus shows the refund our call made (more_info refund:<n>) → recorded
    // as OURS (not "made in PayPlus"), and the rest runs.
    pp.refundsByMoreInfo.set(`refund:${o.orderNumber}`, [{ uid: `rf-late-${RUN}`, amount: PRICE }]);
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: true, refund: 'refunded' });
    expect(refundCalls()).toBe(1);
    const row = await orderOf(o.id);
    expect(row).toMatchObject({ status: 'rejected', refund_transaction_uid: `rf-late-${RUN}`, refund_via: 'reception_cancel' });
    expect(row.refund_note).toContain('נשלח קודם');
  });

  it('a refund PayPlus links to the payment SESSION (ipn, related transactions) counts too: no refund is sent', async () => {
    const o = await liveCollectedOrder();
    const pru = (await pool.query<{ p: string }>(`select card_page_request_uid as p from public.chip_orders where id = $1`, [o.id])).rows[0]!.p;
    pp.relatedBySession.set(pru, [{ uid: `rel-${RUN}-1`, amount: PRICE, more_info: '' }]);
    const body = await (await cancel(o.id, { reason: 'זוכה בממשק' })).json();
    expect(body).toMatchObject({ ok: true, refund: 'outside' });
    expect(refundCalls()).toBe(0);
    expect(await orderOf(o.id)).toMatchObject({ status: 'rejected', refund_via: 'payplus', refund_transaction_uid: `rel-${RUN}-1` });
  });

  it('a PART refunded in PayPlus stops it (nothing sent for the rest); once the rest is refunded there too, the retry finds it and finishes', async () => {
    const o = await liveCollectedOrder({ chips: 2 });
    pp.refundsByMoreInfo.set(String(o.orderNumber), [{ uid: `part-${RUN}-1`, amount: PRICE }]);
    let body = await (await cancel(o.id, { reason: 'חלקי' })).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(body.message).toContain('זיכוי חלקי');
    expect(await orderOf(o.id)).toMatchObject({ status: 'collected', refund_status: 'partial', refunded_amount: PRICE });
    // Asked again on the retry — still a part: still stopped, still nothing sent.
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'refund' });
    pp.refundsByMoreInfo.set(String(o.orderNumber), [{ uid: `part-${RUN}-1`, amount: PRICE }, { uid: `part-${RUN}-2`, amount: PRICE }]);
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: true, refund: 'outside', chips_disabled: 2 });
    expect(refundCalls()).toBe(0);
    expect(await orderOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refunded_amount: 2 * PRICE });
  });

  it('the window\'s "שמור" never issues chips onto an order "ביטול וזיכוי" was started on (the window stayed open)', async () => {
    const o = await liveCollectedOrder({ save: false });
    pp.refund = 'refused';
    expect(await (await cancel(o.id, { reason: 'בוטל בזמן שהחלון פתוח' })).json()).toMatchObject({ ok: false, failed_step: 'refund' });
    const res = await chipsRoute(json('/api/chips', {
      contact_id: made.contact,
      groups: [{ resident_role: 'other', holder_name: 'אורח בדיקה', chip_type: 'physical', numbers: [`X${tag}late`], block: 0 }],
      orderer: { name: 'רונן בדיקה', phone: '0539500074', email: EMAIL, street: null, city: null, zip: null },
      payment: { method: 'card', amount: PRICE, card_token: o.token },
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'card_not_paid' });
    expect(await chipStates(o.id)).toEqual([]);
  });

  it('Morning refuses the credit: it stops at the credit step — refunded ONCE, the order and its chips not cancelled yet; the retry issues it and finishes with no second refund', async () => {
    const o = await liveCollectedOrder();
    morningRefuses = true;
    let body = await (await cancel(o.id, { reason: 'מורנינג למטה' })).json();
    expect(body).toMatchObject({ ok: false, failed_step: 'credit', refund: 'refunded' });
    expect(body.message).toContain('מסמך הזיכוי לא הופק');
    expect(await orderOf(o.id)).toMatchObject({ status: 'collected', refund_status: 'refunded', cancel_failed_step: 'credit' });
    expect(await chipStates(o.id)).toEqual(['active']);
    expect((await docsOf(o.id)).find((x) => x.kind === 'credit')).toMatchObject({ status: 'failed' });
    morningRefuses = false;
    body = await (await cancel(o.id, {})).json();
    expect(body).toMatchObject({ ok: true, refund: 'refunded', chips_disabled: 1 });
    expect(body.credit_numbers).toHaveLength(2);
    expect(refundCalls()).toBe(1);
    expect(await orderOf(o.id)).toMatchObject({ status: 'rejected', cancel_failed_step: null });
    expect((await audit(o.id, 'reception_cancel_failed')).map((m) => m.step)).toEqual(['credit']);
  });

  it('an order with no email: the credit is issued without one and recorded "no_email"', async () => {
    const o = await liveCollectedOrder({ email: null });
    const body = await (await cancel(o.id, { reason: 'בלי מייל' })).json();
    expect(body).toMatchObject({ ok: true, credit_email: { status: 'no_email' } });
    expect(morningDocs.filter((m) => m.type === 330 || m.type === 400).every((m) => m.emails === undefined)).toBe(true);
  });

  it('one run at a time per order: while a run holds the order, another → 409', async () => {
    const o = await liveCollectedOrder();
    await pool.query(
      `update public.chip_orders set cancel_requested_at = now(), cancel_requested_by = $2, cancel_requested_by_name = 'x',
              cancel_request_reason = 'ריצה אחרת', cancel_running_until = now() + interval '1 minute' where id = $1`,
      [o.id, users.super!.id],
    );
    expect((await cancel(o.id, {})).status).toBe(409);
    expect(refundCalls()).toBe(0);
    await pool.query(`update public.chip_orders set cancel_running_until = null where id = $1`, [o.id]);
  });

  it('no request of this file ever left for anywhere but the stubs', () => {
    expect(elsewhere).toEqual([]);
  });
});

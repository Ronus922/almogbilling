import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// THE refund of the chip module (27/11/2026) — one implementation, used
// everywhere a card payment goes back — and what PayPlus reports, against a
// throwaway database (WA_TEST_DATABASE_URL), never prod:
//   - "ביטול וזיכוי" of a WEB order (POST /api/chip-orders/[id]/cancel — it
//     replaced "זיכוי"): admins only, a reason the first time; PayPlus is asked
//     FIRST (Transactions/View, read only), then ONE refund, the Morning credit
//     (330 + a negative 400, issued now), then the order rejected, its chips
//     disabled, the run finished; the orderer is told ("refunded");
//   - a refund that got no answer is NEVER sent again — not at once, not after
//     ten minutes (the gap of the old "זיכוי"); PayPlus showing it lets the
//     retry finish; a refusal is shown, and a retry runs the remaining steps;
//   - "דחה" of a web order the card paid runs the same steps;
//   - a signed callback for an order that is ALREADY paid makes the server ask
//     PayPlus: a cancellation (it looks like the original charge) or a refund
//     (a "Refund" notice) made in the dashboard is NOT recorded and gets NO
//     Morning document — the order carries "בוטל ב-PayPlus — נדרש ביטול
//     וזיכוי" (rows + window), every admin is told once, and "ביטול וזיכוי"
//     finishes it without sending a refund.
// PayPlus and Morning are stubs that answer by URL; anything else is refused.
// Email and WhatsApp senders are stubbed; the rows they record are real. Rows
// are removed by the exact ids made here.

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

const sendWithRetry = vi.fn<(args: { to: string; subject: string; text: string }) => Promise<{ messageId: string; attempts: number }>>(
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
const DEV = { api: 'dev-api-key-refund-test', secret: 'dev-secret-key-refund-test', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-refund-test', secret: 'prod-secret-key-refund-test', page: '99999999-8888-7777-6666-555555555555' };
const ORIGIN = { sandbox: 'https://restapidev.payplus.co.il', production: 'https://restapi.payplus.co.il' } as const;
const MORNING_TOKEN = 'https://api.morning.co/idp/v1/oauth/token';
const MORNING_API = 'https://api.greeninvoice.co.il/api/v1';
const PHONE = '+972539500072';
const EMAIL = 'refund-test@example.test';
const APT = `982${tag}1`;

const orders = await import('@/lib/db/chipOrders');
const { setCardSession, recordCardPayment } = await import('@/lib/db/chipOrderCard');
const { issueChipGroups } = await import('@/lib/db/chips');
const { getChipOrderWindow, saveChipOrderWindow } = await import('@/lib/db/chipOrderWindow');
const { listReadyPickupOrders } = await import('@/lib/db/chipPickup');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');
const { chipOrderRowTags, CHIP_ORDER_TAG_LABEL } = await import('@/lib/chipOrders/orderRows');
const cancelRoute = await import('@/app/api/chip-orders/[id]/cancel/route');
const { POST: rejectRoute } = await import('@/app/api/chip-orders/[id]/reject/route');
const { POST: closeByHandRoute } = await import('@/app/api/chip-orders/[id]/close-by-hand/route');
const { claimDueDocuments, retryFailedDocuments } = await import('@/lib/db/chipOrderDocuments');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');
const { processDueDocuments } = await import('@/lib/chipOrders/documents');
const { __resetMorningTokenForTests } = await import('@/lib/morning/client');
const { __resetMorningProfileForTests } = await import('@/lib/chipOrders/documents');

const SETTINGS = { ...DEFAULT_CHIP_ORDER_SETTINGS, unitPrice: PRICE };
const made = { contact: '', orders: [] as string[], users: [] as string[] };
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: string }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
let admin: { id: string; name: string };

// ── PayPlus and Morning, as stubs that answer by URL ────────────────────────

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Call { host: 'payplus' | 'morning'; origin: string; path: string; apiKey: string | null; body: Record<string, unknown> }
const calls: Call[] = [];
const elsewhere: string[] = [];
let refundSeq = 0;
let morningSeq = 0;
/** What PayPlus answers — set per test. */
const pp = {
  /** Charges PayPlus shows as cancelled (transaction_is_cancelled). */
  cancelled: new Set<string>(),
  /** Refund transactions Transactions/View finds by more_info. */
  refundsByMoreInfo: new Map<string, { uid: string; amount: number }[]>(),
  /** CHARGES Transactions/View finds by more_info — a second charge of the
   *  same order (27/11/2026: the duplicate-charge case). */
  chargesByMoreInfo: new Map<string, { uid: string; amount: number }[]>(),
  /** Transactions/View does not answer (HTTP 500). */
  viewDown: false,
  /** The refund call: 'ok' | 'refused' | 'no_answer'. */
  refund: 'ok' as 'ok' | 'refused' | 'no_answer',
};
const morningDocs: { type: number; emails: unknown; linked: unknown }[] = [];
/** The charge of each payment session (what PaymentPages/ipn reports for it). */
const sessionTx = new Map<string, { tx: string; amount: number }>();

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  if (url.href === MORNING_TOKEN) {
    calls.push({ host: 'morning', origin: url.origin, path: 'token', apiKey: null, body: {} });
    return reply(200, { accessToken: 'morning-test-token', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  }
  if (url.href.startsWith(MORNING_API)) {
    const path = url.href.slice(MORNING_API.length);
    calls.push({ host: 'morning', origin: url.origin, path, apiKey: null, body });
    if (path === '/businesses/me') return reply(200, { type: 2, exemption: false, name: 'בניין בדיקה' });
    if (path === '/documents/info?type=320') return reply(200, { exemption: false, vatRate: 0.18 });
    if (path === '/documents/types?lang=he') return reply(200, [{ id: 320 }, { id: 330 }, { id: 400 }]);
    if (path === '/documents/search') return reply(200, { items: [] });
    if (path === '/documents' && init?.method === 'POST') {
      morningSeq += 1;
      const client = (body.client ?? {}) as Record<string, unknown>;
      morningDocs.push({ type: Number(body.type), emails: client.emails, linked: body.linkedDocumentIds });
      return reply(200, { id: randomUUID(), number: 60000 + morningSeq, type: body.type, url: { origin: `https://docs.example.test/${morningSeq}` } });
    }
    return reply(404, { errorMessage: `no stub for ${path}` });
  }
  if (url.origin !== ORIGIN.sandbox && url.origin !== ORIGIN.production) {
    elsewhere.push(url.href);
    throw new TypeError(`no network in this test: ${url.href}`);
  }
  const path = url.pathname.replace('/api/v1.0/', '');
  calls.push({ host: 'payplus', origin: url.origin, path, apiKey: headers.get('api-key'), body });
  if (path === 'PaymentPages/ipn') {
    // The session's charge only — nothing PayPlus links to it here.
    return reply(200, {
      results: { status: 'success', code: 0, description: 'operation has been success' },
      data: {
        transaction_uid: sessionTx.get(String(body.payment_request_uid))?.tx ?? `charge-of-${String(body.payment_request_uid)}`,
        type: 'Charge', status_code: '000', amount: sessionTx.get(String(body.payment_request_uid))?.amount ?? PRICE, currency: 'ILS',
        more_info: undefined,
      },
    });
  }
  if (path === 'Transactions/View') {
    if (pp.viewDown) return reply(500, { message: 'down in this test' });
    if (typeof body.transaction_uid === 'string') {
      const uid = body.transaction_uid;
      return reply(200, {
        results: { status: 'success', code: 0, description: 'operation has been success' },
        data: [{ transaction: { transaction_uid: uid, transaction_type: 'Charge', status_code: '000', transaction_is_cancelled: pp.cancelled.has(uid), amount: PRICE, more_info: 'x' }, data: {} }],
      });
    }
    const mi = String(body.more_info);
    const list = [
      ...(pp.chargesByMoreInfo.get(mi) ?? []).map((r) => ({ ...r, type: 'Charge' })),
      ...(pp.refundsByMoreInfo.get(mi) ?? []).map((r) => ({ ...r, type: 'Refund' })),
    ];
    if (list.length === 0) return reply(200, { results: { status: 'error', code: 1, description: 'no transactions' }, data: {} });
    return reply(200, {
      results: { status: 'success', code: 0, description: 'operation has been success' },
      data: list.map((r) => ({ transaction: { transaction_uid: r.uid, transaction_type: r.type, status_code: '000', transaction_is_cancelled: pp.cancelled.has(r.uid), amount: r.amount, more_info: mi }, data: {} })),
    });
  }
  if (path === 'Transactions/RefundByTransactionUID') {
    if (pp.refund === 'no_answer') throw new TypeError('fetch failed');
    if (pp.refund === 'refused') {
      return reply(200, { results: { status: 'error', code: 1, description: 'הזיכוי נדחה על ידי חברת האשראי' }, data: { transaction: { status_code: '004' } } });
    }
    refundSeq += 1;
    return reply(200, {
      results: { status: 'success', code: 0, description: 'operation has been success' },
      data: { transaction: { uid: `rf-${RUN}-${refundSeq}`, status_code: '000', amount: body.amount, currency: 'ILS', approval_number: '0654321', more_info: body.more_info } },
    });
  }
  throw new Error(`unexpected PayPlus path in a test: ${url.pathname}`);
});
const payplus = (path: string) => calls.filter((c) => c.host === 'payplus' && c.path === path);
const refundCalls = (tx?: string) => payplus('Transactions/RefundByTransactionUID').filter((c) => !tx || c.body.transaction_uid === tx);

// ── Orders ──────────────────────────────────────────────────────────────────

interface Made { id: string; number: number; total: number; tx: string; itemId: string }
let seq = 0;
/** A web order paid by card — PayPlus's confirmed charge applied straight to the DB. */
async function paidOrder(opts: { isTest?: boolean; chips?: number } = {}): Promise<Made> {
  const isTest = opts.isTest ?? false;
  const o = await orders.createChipOrder({
    fullName: 'דנה בדיקה', phoneE164: PHONE, email: EMAIL, address: 'הרצל 1, חיפה 3300000', role: 'owner',
    rows: [{ role: 'owner', fullName: 'דנה בדיקה', apartmentNumber: APT, chipsCount: opts.chips ?? 2, phoneE164: PHONE, email: null, lease: null, leaseEndDate: null }],
    addressParts: { street: 'הרצל 1', city: 'חיפה', zip: '3300000' },
    ip: '198.51.100.8', isTest,
  }, SETTINGS);
  made.orders.push(o.id);
  seq += 1;
  const env = isTest ? 'sandbox' : 'production';
  const session = `${RUN}-4ef0-4ef0-8ef0-${String(seq).padStart(12, '0')}`;
  expect(await setCardSession(o.id, { env, pageRequestUid: session, amount: o.total })).toBe(true);
  const tx = `tx-${RUN}-rf-${seq}`;
  sessionTx.set(session, { tx, amount: o.total });
  expect(await recordCardPayment({
    env, orderNumber: o.orderNumber, transactionUid: tx, pageRequestUid: session, amount: o.total, approvalNumber: '0012345', last4: '9844',
  }, 'payplus_callback')).toEqual({ kind: 'paid', orderId: o.id });
  const itemId = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [o.id])).rows[0]!.id;
  return { id: o.id, number: o.orderNumber, total: o.total, tx, itemId };
}
let chipSeq = 0;
/** `n` active chips issued onto the order's line. */
async function issueChips(o: Made, n: number): Promise<string[]> {
  const numbers = Array.from({ length: n }, () => { chipSeq += 1; return `F${tag}${chipSeq}`; });
  const r = await issueChipGroups({
    contact_id: made.contact,
    groups: [{ resident_role: 'other', holder_name: 'אורח הזמנה', chip_type: 'physical', numbers, order_item_id: o.itemId }],
  }, admin);
  return r.items.map((c) => c.id);
}

const json = (path: string, body: unknown) => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const cancel = (orderId: string, body: Record<string, unknown>) =>
  cancelRoute.POST(json(`/api/chip-orders/${orderId}/cancel`, body), { params: Promise.resolve({ id: orderId }) });
const preview = (orderId: string) =>
  cancelRoute.GET(new Request(`http://localhost/api/chip-orders/${orderId}/cancel`), { params: Promise.resolve({ id: orderId }) });
const closeByHand = (orderId: string, body: unknown) =>
  closeByHandRoute(json(`/api/chip-orders/${orderId}/close-by-hand`, body), { params: Promise.resolve({ id: orderId }) });
const reject = (orderId: string, body: unknown) =>
  rejectRoute(json(`/api/chip-orders/${orderId}/reject`, body), { params: Promise.resolve({ id: orderId }) });
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');
function callback(payload: unknown, env: 'sandbox' | 'production' = 'production') {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request(`http://localhost/api/public/chip-order/payplus/callback?env=${env}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body, env === 'sandbox' ? DEV.secret : PROD.secret) },
    body,
  }));
}
/** What a cancellation made in the PayPlus dashboard sends: the ORIGINAL
 *  charge's notice, again (seen live 26/11/2026 — Charge, 000, no session). */
const cancelNotice = (o: Made) => ({
  transaction_type: 'Charge',
  transaction: { uid: o.tx, type: 'internal_page', status_code: '000', amount: o.total, currency: 'ILS', approval_number: '0012345', more_info: String(o.number) },
  data: { card_information: { four_digits: '9844' } },
});
/** A refund PayPlus reports (the callback's nested shape). */
const refundNotice = (uid: string, amount: number, moreInfo: string | null) => ({
  transaction_type: 'Refund',
  transaction: {
    uid, type: 'internal_page', status_code: '000', amount, currency: 'ILS', approval_number: '0777777',
    ...(moreInfo === null ? {} : { more_info: moreInfo }),
  },
  data: { card_information: { four_digits: '9844' } },
});

interface OrderRow {
  status: string; reject_reason: string | null; refunded_at: Date | null; refunded_amount: number | null;
  refund_transaction_uid: string | null; refund_via: string | null; refunded_by: string | null; refund_reason: string | null;
  refund_status: string | null; refund_note: string | null; refund_requested_at: Date | null;
  cancel_failed_step: string | null; cancel_error: string | null; cancel_completed_at: Date | null; cancel_request_reason: string | null;
  payplus_reversal_at: Date | null; payplus_reversal_kind: string | null;
}
const rowOf = async (id: string): Promise<OrderRow> => (await pool.query<OrderRow>(
  `select status, reject_reason, refunded_at, refunded_amount::float8 as refunded_amount, refund_transaction_uid, refund_via,
          refunded_by, refund_reason, refund_status, refund_note, refund_requested_at,
          cancel_failed_step, cancel_error, cancel_completed_at, cancel_request_reason, payplus_reversal_at, payplus_reversal_kind
     from public.chip_orders where id = $1`, [id],
)).rows[0]!;
const docsOf = async (orderId: string) => (await pool.query<{
  kind: string; status: string; payment_key: string; credit_of: string | null; amount: number; email_status: string | null; numbers: string[];
}>(
  `select kind, status, payment_key, credit_of, amount::float8 as amount, email_status,
          coalesce((select array_agg(x->>'number') from jsonb_array_elements(morning_docs) x), '{}') as numbers
     from public.chip_order_documents where order_id = $1 order by created_at`, [orderId],
)).rows;
const audits = async (orderId: string, action: string) => (await pool.query<{ actor_user_id: string | null; metadata: Record<string, unknown> }>(
  `select actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2 order by created_at`,
  [orderId, action],
)).rows;
const messagesOf = async (orderId: string) => (await pool.query<{ kind: string; channel: string; status: string }>(
  `select kind, channel, status from public.chip_order_notifications where order_id = $1 order by created_at, channel`, [orderId],
)).rows;
const chipRows = async (ids: string[]) => (await pool.query<{ status: string }>(
  `select status from public.chips where id = any($1::uuid[]) order by chip_number`, [ids],
)).rows.map((r) => r.status);
const activeAdmins = async () => (await pool.query<{ id: string }>(
  `select id from public.users where is_active = true and role in ('super_admin', 'admin') order by id`,
)).rows.map((r) => r.id);
const alertsLike = async (pattern: string) => (await pool.query<{ user_id: string; title: string }>(
  `select user_id, title from public.notifications where type = 'chip_order_alert' and dedupe_key like $1 order by user_id`, [pattern],
)).rows;
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };
/** Handed over by the management — as markChipOrderCollected leaves it (the handover check). */
const collect = (o: Made) => pool.query(
  `update public.chip_orders set status = 'collected', collected_at = now(), handed_over_via = 'management',
          handed_over_by = $2, handed_over_by_name = 'e2e-admin'
    where id = $1`, [o.id, admin.id]);
/** The paid order's invoice, issued by the Morning stub — as after a real payment. */
async function invoiceIssued(o: Made) {
  await processDueDocuments(10, o.id);
  expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued']]);
}

d('the one refund of the chip module — web orders, "דחה", and what PayPlus reports', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchMock);
    pool = new Pool({ connectionString: TEST_URL });
    pool.on('error', () => {});
    const seeded = await requireSeededAdmin(pool);
    admin = { id: seeded, name: 'e2e-admin' };
    users.super = { id: seeded, username: 'e2e-admin', email: null, full_name: 'e2e-admin', role: 'super_admin' };
    const username = `refund-mgr-${tag}`;
    const m = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', 'מנהל זיכוי', 'manager', true) returning id`,
      [username, `${username}@example.test`],
    );
    made.users.push(m.rows[0]!.id);
    users.manager = { id: m.rows[0]!.id, username, email: null, full_name: 'מנהל זיכוי', role: 'manager' };
    for (const mod of ['chips', 'chips_orders_manage']) {
      await pool.query(`insert into public.user_permissions (user_id, module, can_view, can_edit) values ($1, $2, true, true)`, [users.manager.id, mod]);
    }
    made.contact = (await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name, owner_phone) values ($1, 'בעלים בדיקה', '0539500072') returning id`, [APT],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!pool) return;
    const notificationIds = (await pool.query<{ id: string }>(
      `select id from public.notifications
        where type = 'chip_order_alert' and (source_entity_id = any($1::uuid[]) or dedupe_key like $2)`,
      [made.orders, `chip_refund_unmatched:rf-unmatched-${RUN}%`],
    )).rows.map((r) => r.id);
    for (const id of notificationIds) await pool.query(`delete from public.notifications where id = $1`, [id]);
    const chipIds = (await pool.query<{ id: string }>(`select id from public.chips where contact_id = $1`, [made.contact])).rows.map((r) => r.id);
    for (const id of chipIds) {
      await pool.query(`delete from public.chip_events where chip_id = $1`, [id]);
      await pool.query(`delete from public.chips where id = $1`, [id]);
    }
    const docIds = (await pool.query<{ id: string }>(`select id from public.chip_order_documents where order_id = any($1::uuid[])`, [made.orders])).rows.map((r) => r.id);
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1 and credit_of is not null`, [id]);
    for (const id of docIds) await pool.query(`delete from public.chip_order_documents where id = $1`, [id]);
    for (const id of made.orders) {
      await pool.query(`delete from public.audit_log where entity_type = 'chip_order' and entity_id = $1`, [id]);
      await pool.query(`delete from public.chip_orders where id = $1`, [id]);
    }
    if (made.contact) await pool.query(`delete from public.contacts where id = $1`, [made.contact]);
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
      MORNING_API_KEY_ID: 'morning-id-refund-test', MORNING_API_KEY_SECRET: 'morning-secret-refund-test',
    });
    __resetMorningTokenForTests();
    __resetMorningProfileForTests();
    pp.cancelled.clear();
    pp.refundsByMoreInfo.clear();
    pp.chargesByMoreInfo.clear();
    pp.viewDown = false;
    pp.refund = 'ok';
    calls.length = 0;
    morningDocs.length = 0;
    afterQueue.length = 0;
    sendWithRetry.mockClear();
    h.user = null;
  });

  // ── Who, and with what ───────────────────────────────────────────────────

  it('"ביטול וזיכוי" of a web order is admins\' only: a manager with every chips permission gets 403, nobody signed in 401; a reason the first time (400); an unknown order 404 — PayPlus is never called', async () => {
    const o = await paidOrder();
    for (const [key, status] of [['manager', 403], [null, 401]] as const) {
      as(key);
      expect((await cancel(o.id, { reason: 'ניסיון' })).status, String(key)).toBe(status);
      expect((await preview(o.id)).status, String(key)).toBe(status);
    }
    as('super');
    expect((await cancel(o.id, {})).status).toBe(400);
    expect((await cancel('00000000-0000-4000-8000-0000000000ab', { reason: 'לא קיימת' })).status).toBe(404);
    expect(payplus('Transactions/View')).toEqual([]);
    expect(refundCalls()).toEqual([]);
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', refunded_at: null, refund_requested_at: null, cancel_failed_step: null, cancel_request_reason: null });
  });

  // ── The refund ───────────────────────────────────────────────────────────

  it('a web order with chips: PayPlus asked FIRST (read only), ONE refund, the Morning credit (330 + 400, emailed), then the order rejected, its chips disabled, the run finished — and the orderer told', async () => {
    const o = await paidOrder({ chips: 2 });
    await invoiceIssued(o);
    const chips = await issueChips(o, 2);
    as('super');
    const p = (await (await preview(o.id)).json()) as { source: string; amount: number; email: string; chips: string[]; cancellable: boolean; payplus_reversal: unknown };
    expect(p).toMatchObject({ source: 'web', amount: o.total, email: EMAIL, cancellable: true, payplus_reversal: null });
    expect(p.chips).toHaveLength(2);
    calls.length = 0;

    const res = await cancel(o.id, { reason: '  הלקוח ביקש לבטל  ' });
    expect(res.status).toBe(200);
    const run = (await res.json()) as { ok: boolean; source: string; refund: string; credit_numbers: string[]; credit_email: { status: string; to: string }; chips_disabled: number };
    expect(run).toMatchObject({ ok: true, source: 'web', refund: 'refunded', chips_disabled: 2, credit_email: { status: 'sent', to: EMAIL } });
    expect(run.credit_numbers).toHaveLength(2);
    // The order of the calls: every question to PayPlus BEFORE the one refund.
    const pay = calls.filter((c) => c.host === 'payplus').map((c) => c.path);
    expect(pay.at(-1)).toBe('Transactions/RefundByTransactionUID');
    expect(pay.filter((x) => x === 'Transactions/RefundByTransactionUID')).toHaveLength(1);
    expect(pay.slice(0, -1).every((x) => x === 'Transactions/View' || x === 'PaymentPages/ipn')).toBe(true);
    expect(payplus('Transactions/View')[0]!.body).toEqual({ transaction_uid: o.tx });
    const call = refundCalls(o.tx)[0]!;
    expect(call).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api });
    expect(call.body).toMatchObject({ transaction_uid: o.tx, amount: o.total, more_info: `refund:${o.number}` });

    const row = await rowOf(o.id);
    expect(row).toMatchObject({
      status: 'rejected', reject_reason: 'הלקוח ביקש לבטל', refunded_amount: o.total, refund_via: 'admin', refunded_by: admin.id,
      refund_status: 'refunded', refund_reason: 'הלקוח ביקש לבטל', refund_requested_at: null, cancel_failed_step: null,
    });
    expect(row.cancel_completed_at).toBeInstanceOf(Date);
    expect(await chipRows(chips)).toEqual(['inactive', 'inactive']);
    const docs = await docsOf(o.id);
    expect(docs.map((x) => [x.kind, x.status, x.email_status])).toEqual([['invoice', 'issued', 'sent'], ['credit', 'issued', 'sent']]);
    expect(morningDocs.map((x) => x.type)).toEqual([320, 330, 400]);
    expect((await audits(o.id, 'cancel_credit_started'))).toHaveLength(1);
    expect((await audits(o.id, 'cancel_credit_done'))[0]!.metadata).toMatchObject({ source: 'web', chips_disabled: 2, status_before: 'paid' });
    // The orderer is told, as "זיכוי" told them.
    await runAfter();
    expect(sendWithRetry.mock.calls.some((c) => c[0].to === EMAIL)).toBe(true);
    expect((await messagesOf(o.id)).filter((m) => m.kind === 'refunded').length).toBeGreaterThan(0);

    // Done once: again → 409, and no PayPlus call at all.
    calls.length = 0;
    expect((await cancel(o.id, { reason: 'שוב' })).status).toBe(409);
    expect(calls.filter((c) => c.host === 'payplus')).toEqual([]);
    const after = (await (await preview(o.id)).json()) as { cancellable: boolean };
    expect(after.cancellable).toBe(false);
  });

  it('two presses at the same moment → exactly ONE refund call; the other is refused (409)', async () => {
    const o = await paidOrder();
    await invoiceIssued(o);
    as('super');
    const answers = await Promise.all([cancel(o.id, { reason: 'לחיצה כפולה' }), cancel(o.id, { reason: 'לחיצה כפולה' })]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect((await rowOf(o.id)).status).toBe('rejected');
  });

  it('a COLLECTED web order (handed over): the same steps — refunded, credited, its chips disabled — and it stays collected, finished', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    const chips = await issueChips(o, 1);
    await collect(o);
    as('super');
    const run = (await (await cancel(o.id, { reason: 'החזרת צ׳יפ' })).json()) as { ok: boolean; chips_disabled: number };
    expect(run).toMatchObject({ ok: true, chips_disabled: 1 });
    expect(await chipRows(chips)).toEqual(['inactive']);
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'collected', refund_status: 'refunded', refund_reason: 'החזרת צ׳יפ', reject_reason: null });
    expect(row.cancel_completed_at).toBeInstanceOf(Date);
    expect((await audits(o.id, 'cancel_credit_done'))[0]!.metadata).toMatchObject({ status_before: 'collected', closed: false });
    expect((await cancel(o.id, {})).status).toBe(409);
  });

  it('a web order refunded in full before 27/11/2026 (the old "זיכוי") is not run again — 409, nothing sent', async () => {
    const o = await paidOrder();
    await pool.query(
      `update public.chip_orders set refunded_at = now(), refunded_amount = total, refund_status = 'refunded', refund_via = 'admin',
              refund_transaction_uid = $2 where id = $1`, [o.id, `rf-old-${RUN}`]);
    as('super');
    expect((await cancel(o.id, { reason: 'שוב' })).status).toBe(409);
    expect(calls.filter((c) => c.host === 'payplus')).toEqual([]);
  });

  it('PayPlus REFUSES → the run stops at the refund with PayPlus\'s words (nothing recorded, nothing closed); "נסה שוב" sends the refund once and finishes', async () => {
    const o = await paidOrder();
    await invoiceIssued(o);
    as('super');
    pp.refund = 'refused';
    let run = (await (await cancel(o.id, { reason: 'ביטול' })).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(run.message).toContain('הזיכוי נדחה על ידי חברת האשראי');
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', refunded_at: null, refund_status: 'manual_required', refund_requested_at: null, cancel_failed_step: 'refund' });
    expect((await docsOf(o.id)).map((x) => x.kind)).toEqual(['invoice']);
    expect(refundCalls(o.tx)).toHaveLength(1);
    // The window and the row say where it stopped.
    const win = (await getChipOrderWindow(o.itemId))!;
    expect(win.order).toMatchObject({ cancel_failed_step: 'refund', cancel_completed: false });
    expect((await orders.listOpenChipOrderRows()).find((r) => r.order_id === o.id)).toMatchObject({ cancel_failed_step: 'refund' });

    pp.refund = 'ok';
    run = (await (await cancel(o.id, {})).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run.ok).toBe(true);
    expect(refundCalls(o.tx)).toHaveLength(2);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', cancel_failed_step: null, cancel_request_reason: 'ביטול' });
  });

  it('NO answer to the refund → stopped, kept "sent"; a retry — at once, and after ten minutes — NEVER sends a second refund; once PayPlus shows ours, the retry records it and finishes', async () => {
    const o = await paidOrder();
    await invoiceIssued(o);
    as('super');
    pp.refund = 'no_answer';
    let run = (await (await cancel(o.id, { reason: 'ביטול' })).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect((await rowOf(o.id)).refund_requested_at).toBeInstanceOf(Date);
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect((await alertsLike(`chip_refund_unknown:${o.id}:%`)).map((a) => a.user_id)).toEqual(await activeAdmins());
    // The window: still "on its way", whatever the time.
    expect((await getChipOrderWindow(o.itemId))!.order.refund_in_flight).toBe(true);

    pp.refund = 'ok';
    // At once: the call may still be answered — wait.
    run = (await (await cancel(o.id, {})).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(run.message).toContain('ממתינה לתשובה');
    // A minute later: PayPlus shows nothing → never sent again.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '1 minute' where id = $1`, [o.id]);
    run = (await (await cancel(o.id, {})).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(run.message).toContain('לא נשלח זיכוי נוסף');
    // Eleven minutes later (the old "זיכוי" sent a second refund here): still never.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '11 minutes' where id = $1`, [o.id]);
    run = (await (await cancel(o.id, {})).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect((await getChipOrderWindow(o.itemId))!.order.refund_in_flight).toBe(true);

    // PayPlus shows our refund (more_info "refund:<n>"); its own notice is not
    // taken for a refund made in the dashboard — no warning.
    pp.refundsByMoreInfo.set(`refund:${o.number}`, [{ uid: `rf-ours-${RUN}`, amount: o.total }]);
    expect((await callback(refundNotice(`rf-ours-${RUN}`, o.total, `refund:${o.number}`))).status).toBe(200);
    expect((await rowOf(o.id)).payplus_reversal_kind).toBeNull();
    // "נסה שוב" → recorded as ours, finished.
    run = (await (await cancel(o.id, {})).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run.ok).toBe(true);
    expect(refundCalls(o.tx)).toHaveLength(1);
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'rejected', refund_transaction_uid: `rf-ours-${RUN}`, refund_via: 'admin', refund_status: 'refunded' });
    expect(row.refund_note).toContain('נמצא ב-PayPlus');
  });

  it('PayPlus cannot be asked → nothing is sent; the run stops at the refund', async () => {
    const o = await paidOrder();
    as('super');
    pp.viewDown = true;
    const run = (await (await cancel(o.id, { reason: 'ביטול' })).json()) as { ok: boolean; failed_step: string; message: string };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(run.message).toContain('לא נשלח זיכוי');
    expect(refundCalls()).toEqual([]);
    expect((await rowOf(o.id)).refund_requested_at).toBeNull();
  });

  it('a TEST order paid in the sandbox is refunded through the SANDBOX (its keys) — and never gets a document', async () => {
    const t = await paidOrder({ isTest: true });
    as('super');
    const run = (await (await cancel(t.id, { reason: 'בדיקת זיכוי' })).json()) as { ok: boolean; credit_numbers: string[] };
    expect(run).toMatchObject({ ok: true, credit_numbers: [] });
    expect(refundCalls(t.tx)[0]).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api });
    expect(await docsOf(t.id)).toEqual([]);
    expect((await rowOf(t.id)).status).toBe('rejected');
  });

  // ── "דחה" ────────────────────────────────────────────────────────────────

  it('"דחה" of a card-paid web order (a manager) runs the same steps: PayPlus asked first, one refund, the credit — and the rejection message', async () => {
    const o = await paidOrder();
    await invoiceIssued(o);
    as('manager');
    const res = await reject(o.id, { reason: 'אין מלאי' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, refund_status: 'refunded', failed_step: null });
    expect(payplus('Transactions/View').length).toBeGreaterThan(0);
    expect(refundCalls(o.tx)).toHaveLength(1);
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'rejected', reject_reason: 'אין מלאי', refund_via: 'reject', refund_status: 'refunded', refunded_by: users.manager!.id });
    expect(row.cancel_completed_at).toBeInstanceOf(Date);
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'issued']]);
    await runAfter();
    expect((await messagesOf(o.id)).some((m) => m.kind === 'rejected')).toBe(true);
  });

  it('"דחה" while PayPlus does not answer: the order is rejected and stops at the refund (manual_required, the step shown); an admin\'s "המשך" finishes it — one refund in all', async () => {
    const o = await paidOrder();
    await invoiceIssued(o);
    as('manager');
    pp.viewDown = true;
    const res = await reject(o.id, { reason: 'אין מלאי' });
    expect(await res.json()).toMatchObject({ ok: true, refund_status: 'manual_required', failed_step: 'refund' });
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', cancel_failed_step: 'refund', refund_status: 'manual_required' });
    expect(refundCalls()).toEqual([]);
    expect((await orders.listOpenChipOrderRows()).find((r) => r.order_id === o.id)).toMatchObject({ status: 'rejected', cancel_failed_step: 'refund' });
    pp.viewDown = false;
    as('super');
    const run = (await (await cancel(o.id, {})).json()) as { ok: boolean };
    expect(run.ok).toBe(true);
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', reject_reason: 'אין מלאי', refund_status: 'refunded', refund_via: 'admin' });
  });

  // ── What PayPlus reports ─────────────────────────────────────────────────

  it('a cancellation in the PayPlus DASHBOARD (its notice looks like the charge): PayPlus is asked, NOTHING is recorded, NO Morning document — the order says "בוטל ב-PayPlus — נדרש ביטול וזיכוי", every admin is told once; "ביטול וזיכוי" sends no refund and finishes it', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    const chips = await issueChips(o, 1);
    await collect(o);
    pp.cancelled.add(o.tx);
    expect((await callback(cancelNotice(o))).status).toBe(200);
    let row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'collected', payplus_reversal_kind: 'cancelled', refunded_at: null, refund_status: null });
    expect(row.payplus_reversal_at).toBeInstanceOf(Date);
    expect((await docsOf(o.id)).map((x) => x.kind)).toEqual(['invoice']);
    expect(await audits(o.id, 'payplus_reversal_seen')).toHaveLength(1);
    expect((await alertsLike(`chip_payplus_reversal:${o.id}:%`)).map((a) => a.user_id)).toEqual(await activeAdmins());
    expect((await alertsLike(`chip_payplus_reversal:${o.id}:%`))[0]!.title).toContain('בוטל ב-PayPlus — נדרש ביטול וזיכוי');
    expect(refundCalls()).toEqual([]);
    await runAfter();
    expect(await messagesOf(o.id)).toEqual([]);
    // The same notice again: nothing new.
    expect((await callback(cancelNotice(o))).status).toBe(200);
    expect(await audits(o.id, 'payplus_reversal_seen')).toHaveLength(1);

    // The collected web order is in the Orders tab, with the warning tag; the window says it too.
    const r = (await orders.listOpenChipOrderRows()).find((x) => x.order_id === o.id)!;
    expect(r).toMatchObject({ payplus_reversal_kind: 'cancelled', cancel_completed: false });
    expect(chipOrderRowTags(r)[0]).toBe('payplus_reversed');
    expect(CHIP_ORDER_TAG_LABEL.payplus_reversed).toBe('בוטל ב-PayPlus — נדרש ביטול וזיכוי');
    expect((await getChipOrderWindow(o.itemId))!.order).toMatchObject({ payplus_reversal_kind: 'cancelled' });
    as('super');
    expect(((await (await preview(o.id)).json()) as { payplus_reversal: string }).payplus_reversal).toBe('cancelled');

    // One click: no refund sent, the credit issued, the order closed, the warning gone.
    const run = (await (await cancel(o.id, { reason: 'בוטל ב-PayPlus' })).json()) as { ok: boolean; refund: string; chips_disabled: number };
    expect(run).toMatchObject({ ok: true, refund: 'outside', chips_disabled: 1 });
    expect(refundCalls()).toEqual([]);
    row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'collected', refund_via: 'payplus', refund_transaction_uid: `cancelled:${o.tx}`, payplus_reversal_kind: null, payplus_reversal_at: null });
    expect(await chipRows(chips)).toEqual(['inactive']);
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'issued']]);
    expect((await getChipOrderWindow(o.itemId))!.order.payplus_reversal_kind).toBeNull();
    // A later notice of the finished order changes nothing.
    calls.length = 0;
    expect((await callback(cancelNotice(o))).status).toBe(200);
    expect(payplus('Transactions/View')).toEqual([]);
  });

  it('a REFUND made in the PayPlus dashboard ("Refund" notice, the order number): not recorded, no document — the warning; a PARTIAL one says so; our own refund echoed back changes nothing', async () => {
    const full = await paidOrder();
    await invoiceIssued(full);
    pp.refundsByMoreInfo.set(String(full.number), [{ uid: `rf-dash-${RUN}-1`, amount: full.total }]);
    expect((await callback(refundNotice(`rf-dash-${RUN}-1`, full.total, String(full.number)))).status).toBe(200);
    expect(await rowOf(full.id)).toMatchObject({ status: 'paid', payplus_reversal_kind: 'refunded', refunded_at: null, refund_transaction_uid: null });
    expect((await docsOf(full.id)).map((x) => x.kind)).toEqual(['invoice']);

    const part = await paidOrder();
    await invoiceIssued(part);
    pp.refundsByMoreInfo.set(String(part.number), [{ uid: `rf-dash-${RUN}-2`, amount: 10 }]);
    expect((await callback(refundNotice(`rf-dash-${RUN}-2`, 10, String(part.number)))).status).toBe(200);
    expect(await rowOf(part.id)).toMatchObject({ payplus_reversal_kind: 'partial', refunded_at: null });

    // Ours: refunded through "ביטול וזיכוי", then its own notice arrives.
    const ours = await paidOrder();
    await invoiceIssued(ours);
    as('super');
    expect(((await (await cancel(ours.id, { reason: 'ביטול' })).json()) as { ok: boolean }).ok).toBe(true);
    const uid = (await rowOf(ours.id)).refund_transaction_uid!;
    calls.length = 0;
    expect((await callback(refundNotice(uid, ours.total, `refund:${ours.number}`))).status).toBe(200);
    expect(calls.filter((c) => c.host === 'payplus')).toEqual([]);
    expect((await rowOf(ours.id)).payplus_reversal_kind).toBeNull();
  });

  it('while the warning stands nothing moves the order on: "מוכן לאיסוף" and "נאסף" are refused (payplus_reversed), and the guard\'s pickup list leaves it out', async () => {
    const o = await paidOrder({ chips: 1 });
    await issueChips(o, 1);
    pp.cancelled.add(o.tx);
    expect((await callback(cancelNotice(o))).status).toBe(200);
    expect((await rowOf(o.id)).payplus_reversal_kind).toBe('cancelled');
    await expect(orders.markChipOrderReady(o.id)).rejects.toThrow('payplus_reversed');
    // Ready already when PayPlus showed it: never handed over.
    await pool.query(`update public.chip_orders set status = 'ready', ready_at = now() where id = $1`, [o.id]);
    expect((await listReadyPickupOrders()).some((x) => x.id === o.id)).toBe(false);
    await expect(orders.markChipOrderCollected(o.id, admin, { via: 'management' })).rejects.toThrow('payplus_reversed');
    // The row offers no quick step.
    const r = (await orders.listOpenChipOrderRows()).find((x) => x.order_id === o.id)!;
    expect((await import('@/lib/chipOrders/orderRows')).chipOrderRowAction(r, undefined)).toBeNull();
  });

  it('a notice for a paid order PayPlus still shows charged → nothing; PayPlus cannot be asked → 503 (sent again), nothing changed', async () => {
    const o = await paidOrder();
    expect((await callback(cancelNotice(o))).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ payplus_reversal_kind: null, refunded_at: null });
    pp.viewDown = true;
    expect((await callback(cancelNotice(o))).status).toBe(503);
    expect(await rowOf(o.id)).toMatchObject({ payplus_reversal_kind: null });
  });

  it('a "Refund" notice that names no order → ignored, and ONE alert per admin', async () => {
    const uid = `rf-unmatched-${RUN}`;
    expect((await callback(refundNotice(uid, 25, null))).status).toBe(200);
    expect((await callback(refundNotice(uid, 25, null))).status).toBe(200);
    expect((await alertsLike(`chip_refund_unmatched:${uid}:%`)).map((a) => a.user_id)).toEqual(await activeAdmins());
  });

  // ── 27/11/2026 audit: a second charge on the order, and chips after the money went back ──

  it('a SECOND charge on the order refunded in the PayPlus dashboard (what the duplicate-charge alert asks for): PayPlus shows two charges, so a refund by the order number cannot be told apart — the callback marks nothing and tells every admin once; "ביטול וזיכוי" stops at the refund step: nothing sent, nothing recorded, no credit document', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    const dup = `tx-${RUN}-dup-1`;
    const dashRefund = `rf-dup-${RUN}-1`;
    pp.chargesByMoreInfo.set(String(o.number), [{ uid: o.tx, amount: o.total }, { uid: dup, amount: o.total }]);
    pp.refundsByMoreInfo.set(String(o.number), [{ uid: dashRefund, amount: o.total }]);
    expect((await callback(refundNotice(dashRefund, o.total, String(o.number)))).status).toBe(200);
    expect((await callback(refundNotice(dashRefund, o.total, String(o.number)))).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', payplus_reversal_kind: null, payplus_reversal_at: null, refunded_at: null });
    expect(await audits(o.id, 'payplus_reversal_seen')).toEqual([]);
    expect((await alertsLike(`chip_payplus_ambiguous:${o.id}%`)).map((a) => a.user_id)).toEqual(await activeAdmins());
    expect((await docsOf(o.id)).map((x) => x.kind)).toEqual(['invoice']);

    as('super');
    const run = (await (await cancel(o.id, { reason: 'הלקוח ביטל' })).json()) as { ok: boolean; failed_step: string | null; message: string | null };
    expect(run).toMatchObject({ ok: false, failed_step: 'refund' });
    expect(run.message).toContain('יותר מחיוב אחד');
    expect(refundCalls()).toEqual([]);
    expect(await rowOf(o.id)).toMatchObject({
      status: 'paid', refunded_at: null, refund_transaction_uid: null, refund_status: 'manual_required', cancel_failed_step: 'refund', cancel_completed_at: null,
    });
    expect((await docsOf(o.id)).map((x) => x.kind)).toEqual(['invoice']);
  });

  it('a second charge after OUR refund got no answer: the ambiguity keeps the "never sent again" mark; once PayPlus shows our own refund covering the charge, the dashboard refund of the other charge no longer matters — recorded, credited, closed, nothing sent again', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    pp.refund = 'no_answer';
    as('super');
    expect(((await (await cancel(o.id, { reason: 'הלקוח ביטל' })).json()) as { failed_step: string }).failed_step).toBe('refund');
    const mark = (await rowOf(o.id)).refund_requested_at;
    expect(mark).toBeInstanceOf(Date);
    expect(refundCalls(o.tx)).toHaveLength(1);
    // A duplicate charge, refunded in the dashboard; our refund not visible yet.
    pp.chargesByMoreInfo.set(String(o.number), [{ uid: o.tx, amount: o.total }, { uid: `tx-${RUN}-dup-3`, amount: o.total }]);
    pp.refundsByMoreInfo.set(String(o.number), [{ uid: `rf-dup-${RUN}-3`, amount: o.total }]);
    await pool.query(`update public.chip_orders set refund_requested_at = refund_requested_at - interval '5 minutes' where id = $1`, [o.id]);
    const stopped = (await (await cancel(o.id, {})).json()) as { failed_step: string; message: string };
    expect(stopped).toMatchObject({ failed_step: 'refund' });
    expect(stopped.message).toContain('יותר מחיוב אחד');
    expect((await rowOf(o.id)).refund_requested_at).toEqual(new Date(mark!.getTime() - 5 * 60_000));
    expect(refundCalls(o.tx)).toHaveLength(1);
    // PayPlus now shows OUR refund (its answer was lost) — it covers the charge.
    pp.refundsByMoreInfo.set(`refund:${o.number}`, [{ uid: `rf-ours-${RUN}-3`, amount: o.total }]);
    const done = (await (await cancel(o.id, {})).json()) as { ok: boolean };
    expect(done.ok).toBe(true);
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refund_transaction_uid: `rf-ours-${RUN}-3` });
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'issued']]);
  });

  it('a second charge with NOTHING refunded in the dashboard: "ביטול וזיכוי" refunds the order\'s own charge, by its id, once', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    pp.chargesByMoreInfo.set(String(o.number), [{ uid: o.tx, amount: o.total }, { uid: `tx-${RUN}-dup-2`, amount: o.total }]);
    as('super');
    expect(((await (await cancel(o.id, { reason: 'הלקוח ביטל' })).json()) as { ok: boolean }).ok).toBe(true);
    expect(refundCalls().map((c) => c.body.transaction_uid)).toEqual([o.tx]);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refund_via: 'admin' });
  });

  it('once the money is on its way back — "ביטול וזיכוי" started, a refund recorded, or PayPlus showed it cancelled — the order\'s window issues NO new chip (an edit of a name still saves); an ordinary paid order still takes its chips', async () => {
    const save = async (o: Made, number: string | null) => {
      const holder = (await pool.query<{ id: string }>(`select id from public.chip_order_holders where order_id = $1 order by position limit 1`, [o.id])).rows[0]!;
      return saveChipOrderWindow(o.id, {
        holders: [{
          id: holder.id, item_id: o.itemId, role: 'owner', full_name: number ? 'דנה בדיקה' : 'דנה בדיקה שינוי', phone: PHONE, email: null,
          new_chips: number ? [{ number, chip_type: 'physical' }] : [],
        }],
      }, admin, PRICE);
    };
    const fine = await paidOrder({ chips: 1 });
    expect((await save(fine, `W${tag}1`))!.issued).toBe(1);

    // "ביטול וזיכוי" started and stopped (PayPlus could not be asked).
    const started = await paidOrder({ chips: 1 });
    pp.viewDown = true;
    as('super');
    expect(((await (await cancel(started.id, { reason: 'הלקוח ביטל' })).json()) as { failed_step: string }).failed_step).toBe('refund');
    pp.viewDown = false;
    await expect(save(started, `W${tag}2`)).rejects.toThrow('order_undoing');
    expect(await save(started, null)).toMatchObject({ issued: 0 });
    expect((await pool.query(`select full_name from public.chip_order_holders where order_id = $1 order by position limit 1`, [started.id])).rows[0].full_name)
      .toBe('דנה בדיקה שינוי');

    // PayPlus showed it cancelled (the callback's warning).
    const reversed = await paidOrder({ chips: 1 });
    pp.cancelled.add(reversed.tx);
    expect((await callback(cancelNotice(reversed))).status).toBe(200);
    expect((await rowOf(reversed.id)).payplus_reversal_kind).toBe('cancelled');
    await expect(save(reversed, `W${tag}3`)).rejects.toThrow('order_undoing');

    // A refund recorded, the credit step stopped (Morning refused): no chip either.
    const refunded = await paidOrder({ chips: 1 });
    await pool.query(
      `update public.chip_orders set refunded_at = now(), refunded_amount = total, refund_status = 'refunded', refund_via = 'admin',
              refund_transaction_uid = $2 where id = $1`, [refunded.id, `rf-${RUN}-undo`]);
    await expect(save(refunded, `W${tag}4`)).rejects.toThrow('order_undoing');
    expect((await pool.query(`select count(*)::int as n from public.chips where chip_number = any($1::text[])`,
      [[`W${tag}2`, `W${tag}3`, `W${tag}4`]])).rows[0].n).toBe(0);
  });

  // ── "סגירה ידנית" (27/11/2026) ───────────────────────────────────────────

  it('"סגירה ידנית" of a refund that got no answer: super admin only, a reason required — nothing sent to PayPlus or Morning; the order cancelled, its chip disabled, the run finished, marked for good with who, why and the step, audited; "ביטול וזיכוי" is not offered again', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    const chips = await issueChips(o, 1);
    pp.refund = 'no_answer';
    as('super');
    expect(((await (await cancel(o.id, { reason: 'הלקוח ביטל' })).json()) as { failed_step: string }).failed_step).toBe('refund');
    expect(await rowOf(o.id)).toMatchObject({ refund_status: 'manual_required', cancel_failed_step: 'refund' });
    expect((await rowOf(o.id)).refund_requested_at).toBeInstanceOf(Date);

    // An admin (not super), a manager, nobody — refused; no reason — 400.
    const username = `close-admin-${tag}`;
    const a = await pool.query<{ id: string }>(
      `insert into public.users (username, email, password_hash, full_name, role, is_active) values ($1, $2, 'x', 'אדמין סגירה', 'admin', true) returning id`,
      [username, `${username}@example.test`],
    );
    made.users.push(a.rows[0]!.id);
    users.admin = { id: a.rows[0]!.id, username, email: null, full_name: 'אדמין סגירה', role: 'admin' };
    for (const [key, status] of [['admin', 403], ['manager', 403], [null, 401]] as const) {
      as(key);
      expect((await closeByHand(o.id, { reason: 'בדקתי ב-PayPlus' })).status, String(key)).toBe(status);
    }
    as('super');
    expect((await closeByHand(o.id, {})).status).toBe(400);
    expect((await closeByHand(o.id, { reason: ' ' })).status).toBe(400);

    calls.length = 0;
    morningDocs.length = 0;
    const res = await closeByHand(o.id, { reason: 'הזיכוי בוצע בממשק PayPlus' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, order_number: o.number, step: 'refund', chips_disabled: 1, documents_stopped: 0 });
    expect(calls).toEqual([]);
    const row = (await pool.query<{
      status: string; reject_reason: string; cancel_completed_at: Date | null; cancel_failed_step: string | null;
      closed_by_hand_at: Date | null; closed_by_hand_by: string; closed_by_hand_by_name: string; closed_by_hand_reason: string; closed_by_hand_step: string;
    }>(`select status, reject_reason, cancel_completed_at, cancel_failed_step, closed_by_hand_at, closed_by_hand_by, closed_by_hand_by_name,
               closed_by_hand_reason, closed_by_hand_step from public.chip_orders where id = $1`, [o.id])).rows[0]!;
    expect(row).toMatchObject({
      status: 'rejected', reject_reason: 'הלקוח ביטל', cancel_failed_step: null, closed_by_hand_by: admin.id,
      closed_by_hand_by_name: 'e2e-admin', closed_by_hand_reason: 'הזיכוי בוצע בממשק PayPlus', closed_by_hand_step: 'refund',
    });
    expect(row.cancel_completed_at).toBeInstanceOf(Date);
    expect(row.closed_by_hand_at).toBeInstanceOf(Date);
    expect(await chipRows(chips)).toEqual(['inactive']);
    const audit = await audits(o.id, 'cancel_closed_by_hand');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: admin.id, metadata: { step: 'refund', reason: 'הזיכוי בוצע בממשק PayPlus', refund_unanswered: true, chips_disabled: 1 } });
    // The window and the row say so, for good; nothing is offered again.
    expect((await getChipOrderWindow(o.itemId))!.order).toMatchObject({ closed_by_hand_step: 'refund', closed_by_hand_by_name: 'e2e-admin', cancel_completed: true });
    const r = (await orders.listOpenChipOrderRows()).find((x) => x.order_id === o.id)!;
    expect(chipOrderRowTags(r)).toContain('closed_by_hand');
    expect(CHIP_ORDER_TAG_LABEL.closed_by_hand).toBe('נסגרה ידנית');
    expect((await cancel(o.id, { reason: 'שוב' })).status).toBe(409);
    expect((await closeByHand(o.id, { reason: 'שוב' })).status).toBe(409);
    // A late notice from PayPlus about it changes nothing.
    pp.refundsByMoreInfo.set(`refund:${o.number}`, [{ uid: `rf-late-${RUN}`, amount: o.total }]);
    expect((await callback(refundNotice(`rf-late-${RUN}`, o.total, `refund:${o.number}`))).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ payplus_reversal_kind: null, refunded_at: null });
    expect(morningDocs).toEqual([]);
  });

  it('"סגירה ידנית" of a credit Morning did not issue: the waiting credit document is stopped — not issued by the queue once Morning is back, not by "הפק שוב" — and the order closes; the refund that was made stays recorded', async () => {
    const o = await paidOrder({ chips: 1 });
    await invoiceIssued(o);
    // Morning is gone: the refund goes through, the credit cannot be issued.
    delete fakeEnv.MORNING_API_KEY_ID;
    delete fakeEnv.MORNING_API_KEY_SECRET;
    __resetMorningTokenForTests();
    as('super');
    expect(((await (await cancel(o.id, { reason: 'הלקוח ביטל' })).json()) as { failed_step: string }).failed_step).toBe('credit');
    expect(await rowOf(o.id)).toMatchObject({ refund_status: 'refunded', cancel_failed_step: 'credit' });
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'pending']]);
    // Morning merely not connected: a retry will issue it — not closed by hand.
    expect((await closeByHand(o.id, { reason: 'מסמך הזיכוי יופק ידנית במורנינג' })).status).toBe(409);
    // Morning refused it (as failDocument leaves the row once Morning says no).
    await pool.query(
      `update public.chip_order_documents set status = 'failed', last_error = 'מורנינג סירב להפיק את המסמך' where order_id = $1 and kind = 'credit'`, [o.id]);

    const res = await closeByHand(o.id, { reason: 'מסמך הזיכוי יופק ידנית במורנינג' });
    expect(await res.json()).toMatchObject({ ok: true, step: 'credit', documents_stopped: 1 });
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'failed']]);
    // Morning is back: the queue, "הפק שוב" and a direct run issue nothing for it.
    fakeEnv.MORNING_API_KEY_ID = 'morning-id-refund-test';
    fakeEnv.MORNING_API_KEY_SECRET = 'morning-secret-refund-test';
    __resetMorningTokenForTests();
    morningDocs.length = 0;
    expect(await retryFailedDocuments(o.id)).toBe(0);
    expect(await claimDueDocuments(10, 10, o.id)).toEqual([]);
    await processDueDocuments(10, o.id);
    expect(morningDocs).toEqual([]);
    expect((await docsOf(o.id)).map((x) => [x.kind, x.status])).toEqual([['invoice', 'issued'], ['credit', 'failed']]);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', cancel_failed_step: null });
  });

  it('"סגירה ידנית" is refused where a retry can still settle it: an order whose run never started, a refund step that stopped only because PayPlus could not be asked, and a run holding the order right now', async () => {
    as('super');
    const fresh = await paidOrder();
    expect((await closeByHand(fresh.id, { reason: 'ניסיון' })).status).toBe(409);
    const asked = await paidOrder();
    pp.viewDown = true;
    expect(((await (await cancel(asked.id, { reason: 'הלקוח ביטל' })).json()) as { failed_step: string }).failed_step).toBe('refund');
    pp.viewDown = false;
    expect((await rowOf(asked.id)).refund_status).toBeNull();
    expect((await closeByHand(asked.id, { reason: 'ניסיון' })).status).toBe(409);
    const busy = await paidOrder();
    pp.refund = 'no_answer';
    await cancel(busy.id, { reason: 'הלקוח ביטל' });
    await pool.query(`update public.chip_orders set cancel_running_until = now() + interval '5 minutes' where id = $1`, [busy.id]);
    expect((await closeByHand(busy.id, { reason: 'ניסיון' })).status).toBe(409);
    await pool.query(`update public.chip_orders set cancel_running_until = null where id = $1`, [busy.id]);
    expect((await closeByHand(busy.id, { reason: 'בדקתי ב-PayPlus' })).status).toBe(200);
  });

  it('no request of this file ever left for anywhere but the PayPlus and Morning stubs', () => {
    expect(elsewhere).toEqual([]);
  });
});

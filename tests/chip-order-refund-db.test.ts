import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// Refunds of card-paid chip orders through PayPlus (26/11/2026), against a
// throwaway database (WA_TEST_DATABASE_URL), never prod:
//   - "זיכוי" (POST /api/chip-orders/[id]/refund) is admins' only, needs a
//     reason, and refunds the FULL charge through
//     Transactions/RefundByTransactionUID in the order's own environment —
//     once: a second press, or two at the same moment, never make a second call;
//   - PayPlus's answer is recorded with the order, its chips, the Morning credit
//     row (never for a test order) and the audit row, in one transaction; the
//     customer of a web order is told ("refunded");
//   - PayPlus refusing → manual_required with its words; no answer → unknown,
//     kept in flight for ten minutes, admins alerted;
//   - "דחה" of a card-paid order refunds through the same engine;
//   - a refund PayPlus REPORTS (a signed callback, transaction_type Refund) is
//     recorded once per refund id.
// PayPlus is never called: fetch is a stub that answers by URL path and
// refuses anything else. Email and WhatsApp senders are stubbed; the rows
// they record are real. Rows are removed by the exact ids made here.

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

// recordRefund as it is — except when a test makes its next call fail (a
// database error right after PayPlus confirmed a refund).
const rr = vi.hoisted(() => ({ failNext: false }));
vi.mock('@/lib/db/chipOrderRefund', async (orig) => {
  const real = await orig<typeof import('@/lib/db/chipOrderRefund')>();
  return {
    ...real,
    recordRefund: async (...args: Parameters<typeof real.recordRefund>) => {
      if (rr.failNext) {
        rr.failNext = false;
        throw new Error('Connection terminated unexpectedly');
      }
      return real.recordRefund(...args);
    },
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN = String(Date.now()).slice(-8);
const tag = RUN.slice(-6);
const PRICE = 40;
const APP_URL = 'https://chips.example.test';
const DEV = { api: 'dev-api-key-refund-test', secret: 'dev-secret-key-refund-test', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-refund-test', secret: 'prod-secret-key-refund-test', page: '99999999-8888-7777-6666-555555555555' };
const ORIGIN = { sandbox: 'https://restapidev.payplus.co.il', production: 'https://restapi.payplus.co.il' } as const;
const PHONE = '+972539500072';
const EMAIL = 'refund-test@example.test';
const APT = `982${tag}1`;

const orders = await import('@/lib/db/chipOrders');
const { setCardSession, recordCardPayment } = await import('@/lib/db/chipOrderCard');
const { issueChipGroups } = await import('@/lib/db/chips');
const { applyPayPlusRefundNotice } = await import('@/lib/chipOrders/refund');
const { payplusConfigFor, readPayPlusTransaction } = await import('@/lib/payplus/client');
const { DEFAULT_CHIP_ORDER_SETTINGS, CHIP_ORDER_REFUND_LABEL } = await import('@/lib/chipOrders/model');
const { POST: refundRoute } = await import('@/app/api/chip-orders/[id]/refund/route');
const { POST: rejectRoute } = await import('@/app/api/chip-orders/[id]/reject/route');
const { POST: callbackRoute } = await import('@/app/api/public/chip-order/payplus/callback/route');

const SETTINGS = { ...DEFAULT_CHIP_ORDER_SETTINGS, unitPrice: PRICE };
const made = { contact: '', orders: [] as string[], users: [] as string[] };
const unmatchedUids: string[] = [];
const users: Record<string, { id: string; username: string; email: string | null; full_name: string | null; role: string }> = {};
const as = (key: string | null) => { h.user = key ? users[key]! : null; };
let admin: { id: string; name: string };

// ── PayPlus, as a stub that answers by URL path ─────────────────────────────

interface Sent { origin: string; path: string; apiKey: string | null; secretKey: string | null; body: Record<string, unknown> }
const sent: Sent[] = [];
const elsewhere: string[] = [];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let refundSeq = 0;
/** PayPlus refunded: data.transaction carries the refund's own uid. */
const REFUNDED = (body: Record<string, unknown>) => {
  refundSeq += 1;
  return reply(200, {
    results: { status: 'success', code: 0, description: 'operation has been success' },
    data: { transaction: { uid: `rf-${RUN}-${refundSeq}`, number: 'R0001', type: 'internal_page', status_code: '000', amount: body.amount, currency: 'ILS', approval_number: '0654321', more_info: body.more_info } },
  });
};
let refundAnswer: (body: Record<string, unknown>) => Response | Promise<Response> = REFUNDED;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init?.headers);
  const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
  if (url.origin !== ORIGIN.sandbox && url.origin !== ORIGIN.production) {
    elsewhere.push(url.href);
    throw new TypeError(`no network in this test: ${url.href}`);
  }
  sent.push({ origin: url.origin, path: url.pathname, apiKey: headers.get('api-key'), secretKey: headers.get('secret-key'), body });
  if (url.pathname === '/api/v1.0/Transactions/RefundByTransactionUID') return refundAnswer(body);
  throw new Error(`unexpected PayPlus path in a test: ${url.pathname}`);
});
const refundCalls = (tx?: string) => sent.filter((s) => s.path === '/api/v1.0/Transactions/RefundByTransactionUID' && (!tx || s.body.transaction_uid === tx));

// ── Orders ──────────────────────────────────────────────────────────────────

interface Made { id: string; number: number; trackingToken: string; total: number; tx: string; itemId: string }
let seq = 0;
/** An order paid by card — PayPlus's confirmed charge applied straight to the DB. */
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
  expect(await recordCardPayment({
    env, orderNumber: o.orderNumber, transactionUid: tx, pageRequestUid: session, amount: o.total, approvalNumber: '0012345', last4: '9844',
  }, 'payplus_callback')).toEqual({ kind: 'paid', orderId: o.id });
  const itemId = (await pool.query<{ id: string }>(`select id from public.chip_order_items where order_id = $1`, [o.id])).rows[0]!.id;
  return { id: o.id, number: o.orderNumber, trackingToken: o.trackingToken, total: o.total, tx, itemId };
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

const refund = (orderId: string, body: unknown) => refundRoute(
  new Request(`http://localhost/api/chip-orders/${orderId}/refund`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: orderId }) },
);
const reject = (orderId: string, body: unknown) => rejectRoute(
  new Request(`http://localhost/api/chip-orders/${orderId}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: orderId }) },
);
const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('base64');
function callback(payload: unknown, env: 'sandbox' | 'production') {
  const body = JSON.stringify(payload);
  return callbackRoute(new Request(`http://localhost/api/public/chip-order/payplus/callback?env=${env}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'PayPlus', hash: sign(body, env === 'sandbox' ? DEV.secret : PROD.secret) },
    body,
  }));
}
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
  status: string; reject_reason: string | null; rejected_at: Date | null; refunded_at: Date | null; refunded_amount: number | null;
  refund_transaction_uid: string | null; refund_via: string | null; refunded_by: string | null; refunded_by_name: string | null;
  refund_reason: string | null; refund_status: string | null; refund_note: string | null; refund_requested_at: Date | null;
}
const rowOf = async (id: string): Promise<OrderRow> => (await pool.query<OrderRow>(
  `select status, reject_reason, rejected_at, refunded_at, refunded_amount::float8 as refunded_amount, refund_transaction_uid, refund_via,
          refunded_by, refunded_by_name, refund_reason, refund_status, refund_note, refund_requested_at
     from public.chip_orders where id = $1`, [id],
)).rows[0]!;
const docsOf = async (orderId: string) => (await pool.query<{
  id: string; kind: string; payment_key: string; credit_of: string | null; amount: number; payment_method: string; status: string; details: Record<string, unknown>;
}>(
  `select id, kind, payment_key, credit_of, amount::float8 as amount, payment_method, status, details
     from public.chip_order_documents where order_id = $1 order by created_at`, [orderId],
)).rows;
const audits = async (orderId: string, action: string) => (await pool.query<{ actor_user_id: string | null; metadata: Record<string, unknown> }>(
  `select actor_user_id, metadata from public.audit_log where entity_type = 'chip_order' and entity_id = $1 and action = $2 order by created_at`,
  [orderId, action],
)).rows;
const messagesOf = async (orderId: string) => (await pool.query<{ kind: string; channel: string; status: string }>(
  `select kind, channel, status from public.chip_order_notifications where order_id = $1 order by channel, created_at`, [orderId],
)).rows;
const chipRows = async (ids: string[]) => (await pool.query<{ status: string; deactivated_by: string | null; deactivation_reason: string | null }>(
  `select status, deactivated_by, deactivation_reason from public.chips where id = any($1::uuid[]) order by chip_number`, [ids],
)).rows;
const activeAdmins = async () => (await pool.query<{ id: string }>(
  `select id from public.users where is_active = true and role in ('super_admin', 'admin') order by id`,
)).rows.map((r) => r.id);
const alertsLike = async (pattern: string) => (await pool.query<{ user_id: string; title: string; source_entity_id: string | null }>(
  `select user_id, title, source_entity_id from public.notifications where type = 'chip_order_alert' and dedupe_key like $1 order by user_id`, [pattern],
)).rows;
const runAfter = async () => { for (const fn of afterQueue.splice(0)) await fn(); };

d('refunds of card-paid chip orders through PayPlus', () => {
  let r1: Made;
  let r1Chips: string[] = [];

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
        where type = 'chip_order_alert' and (source_entity_id = any($1::uuid[]) or dedupe_key like any($2::text[]))`,
      [made.orders, unmatchedUids.map((u) => `chip_refund_unmatched:${u}:%`)],
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
    // Morning is not connected here: credit rows are queued and wait.
    Object.assign(fakeEnv, {
      APP_URL,
      PAYPLUS_MODE: 'production',
      PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page,
      PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page,
    });
    refundAnswer = REFUNDED;
    rr.failNext = false;
    sent.length = 0;
    afterQueue.length = 0;
    sendWithRetry.mockClear();
    h.user = null;
  });

  // ── Who, and with what ───────────────────────────────────────────────────

  it('admins only: a manager with every chips permission gets 403, nobody signed in 401 — PayPlus is not called and nothing changes', async () => {
    r1 = await paidOrder({ chips: 2 });
    for (const [key, status] of [['manager', 403], [null, 401]] as const) {
      as(key);
      expect((await refund(r1.id, { reason: 'ניסיון זיכוי' })).status, String(key)).toBe(status);
    }
    expect(refundCalls()).toEqual([]);
    expect(await rowOf(r1.id)).toMatchObject({ status: 'paid', refunded_at: null, refund_requested_at: null, refund_status: null });
  });

  it('a reason is required (400); an unknown order is 404 — PayPlus is not called', async () => {
    as('super');
    for (const body of [{}, { reason: '' }, { reason: ' א ' }, { reason: 5 }]) expect((await refund(r1.id, body)).status, JSON.stringify(body)).toBe(400);
    expect((await refund('00000000-0000-4000-8000-0000000000ab', { reason: 'לא קיימת' })).status).toBe(404);
    expect((await refund('not-an-id', { reason: 'לא קיימת' })).status).toBe(404);
    expect(refundCalls()).toEqual([]);
    expect((await rowOf(r1.id)).refund_requested_at).toBeNull();
  });

  // ── The refund ───────────────────────────────────────────────────────────

  it('a production card-paid order: ONE RefundByTransactionUID call (its transaction, the amount charged, no PayPlus invoice) — then the order, its chips, the credit row, the audit row and the message', async () => {
    r1Chips = await issueChips(r1, 2);
    const [invoice] = await docsOf(r1.id);
    expect(invoice).toMatchObject({ kind: 'invoice', payment_key: `card:${r1.tx}`, status: 'pending' });

    as('super');
    const res = await refund(r1.id, { reason: '  הלקוח ביקש לבטל  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'refunded', full: true, closed: true, chipsDisabled: 2 });

    expect(refundCalls()).toHaveLength(1);
    const call = refundCalls()[0]!;
    expect(call).toMatchObject({ origin: ORIGIN.production, apiKey: PROD.api, secretKey: PROD.secret });
    expect(call.body).toEqual({ transaction_uid: r1.tx, amount: r1.total, more_info: `refund:${r1.number}`, initial_invoice: false });
    const refundUid = `rf-${RUN}-${refundSeq}`;

    const row = await rowOf(r1.id);
    expect(row).toMatchObject({
      status: 'rejected', reject_reason: 'הלקוח ביקש לבטל', refunded_amount: r1.total, refund_transaction_uid: refundUid,
      refund_via: 'admin', refunded_by: users.super!.id, refunded_by_name: 'e2e-admin', refund_reason: 'הלקוח ביקש לבטל',
      refund_status: 'refunded', refund_note: null, refund_requested_at: null,
    });
    expect(row.refunded_at).not.toBeNull();
    expect(row.rejected_at).not.toBeNull();

    // Its active chips are disabled — never deleted — by whoever refunded.
    expect(await chipRows(r1Chips)).toEqual([
      { status: 'inactive', deactivated_by: users.super!.id, deactivation_reason: 'unknown' },
      { status: 'inactive', deactivated_by: users.super!.id, deactivation_reason: 'unknown' },
    ]);
    const note = (await pool.query(`select new_value->>'note' as note from public.chip_events where chip_id = $1 and event_type = 'deactivated'`, [r1Chips[0]])).rows[0].note;
    expect(note).toBe(`זיכוי הזמנה ${r1.number}`);

    // ONE credit row, crediting the invoice row.
    const rows = await docsOf(r1.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'credit', payment_key: `refund:${refundUid}`, credit_of: invoice!.id, amount: r1.total, payment_method: 'card', status: 'pending' });
    expect(rows[1]!.details).toMatchObject({ refund_uid: refundUid, via: 'admin' });

    expect(await audits(r1.id, 'refunded')).toEqual([{
      actor_user_id: users.super!.id,
      metadata: {
        via: 'admin', refund_uid: refundUid, amount: r1.total, total_refunded: r1.total, full: true, closed: true,
        chips_disabled: 2, reason: 'הלקוח ביקש לבטל', env: 'production',
      },
    }]);

    // The customer is told after the answer.
    expect(await messagesOf(r1.id)).toEqual([]);
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect(await messagesOf(r1.id)).toEqual([
      { kind: 'refunded', channel: 'email', status: 'sent' },
      { kind: 'refunded', channel: 'whatsapp', status: 'skipped' },
    ]);
    const mail = sendWithRetry.mock.calls.find((c) => c[0].to === EMAIL)![0];
    expect(mail.subject).toContain('זוכתה');
    expect(mail.subject).toContain(`הזמנה ${r1.number}`);
    expect(mail.text).toContain(`₪${r1.total}`);
    expect(mail.text).toContain('ההזמנה בוטלה.');
  });

  it('a second "זיכוי" → 409 already_refunded — and NO second PayPlus call', async () => {
    as('super');
    const res = await refund(r1.id, { reason: 'שוב' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('ההזמנה כבר זוכתה');
    expect(refundCalls()).toEqual([]);
    expect((await docsOf(r1.id)).filter((r) => r.kind === 'credit')).toHaveLength(1);
    expect(await audits(r1.id, 'refunded')).toHaveLength(1);
    expect(afterQueue).toHaveLength(0);
  });

  it('two "זיכוי" at the same moment → exactly ONE PayPlus call; the other is refused (409)', async () => {
    const o = await paidOrder({ chips: 1 });
    refundAnswer = async (body) => { await new Promise((r) => setTimeout(r, 150)); return REFUNDED(body); };
    as('super');
    const answers = await Promise.all([refund(o.id, { reason: 'לחיצה כפולה' }), refund(o.id, { reason: 'לחיצה כפולה' })]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect((await docsOf(o.id)).filter((r) => r.kind === 'credit')).toHaveLength(1);
    expect(await audits(o.id, 'refunded')).toHaveLength(1);
    expect(await rowOf(o.id)).toMatchObject({ refund_status: 'refunded', refund_requested_at: null });
  });

  it('a COLLECTED order stays collected: refunded, its chips disabled, the reason kept on the refund (not as a rejection)', async () => {
    const o = await paidOrder({ chips: 1 });
    const chips = await issueChips(o, 1);
    await pool.query(`update public.chip_orders set status = 'collected', ready_at = now(), collected_at = now() where id = $1`, [o.id]);
    as('super');
    const res = await refund(o.id, { reason: 'החזרת צ׳יפ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'refunded', full: true, closed: false, chipsDisabled: 1 });
    expect(await rowOf(o.id)).toMatchObject({
      status: 'collected', reject_reason: null, rejected_at: null, refund_reason: 'החזרת צ׳יפ', refund_status: 'refunded', refund_via: 'admin',
    });
    expect((await chipRows(chips))[0]!.status).toBe('inactive');
    await runAfter();
    expect((await messagesOf(o.id)).map((m) => m.kind)).toEqual(['refunded', 'refunded']);
    expect(sendWithRetry.mock.calls.find((c) => c[0].to === EMAIL)![0].text).toContain('הצ׳יפים של ההזמנה הושבתו.');
  });

  it('PayPlus REFUSES → manual_required with its words; nothing is recorded or closed; a later "זיכוי" goes through', async () => {
    const o = await paidOrder({ chips: 1 });
    refundAnswer = () => reply(200, { results: { status: 'error', code: 1, description: 'הזיכוי נדחה על ידי חברת האשראי' }, data: { transaction: { status_code: '004' } } });
    as('super');
    let res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, kind: 'manual_required' });
    expect(body.note).toBe('PayPlus סירב לזיכוי: הזיכוי נדחה על ידי חברת האשראי (קוד 004)');
    expect(await rowOf(o.id)).toMatchObject({
      status: 'paid', refunded_at: null, refund_status: 'manual_required', refund_note: body.note, refund_requested_at: null, refund_transaction_uid: null,
    });
    expect((await docsOf(o.id)).filter((r) => r.kind === 'credit')).toEqual([]);
    expect(await audits(o.id, 'refunded')).toEqual([]);
    expect(afterQueue).toHaveLength(0);

    // A refusal by HTTP status (4xx) is a refusal too.
    refundAnswer = () => reply(422, { message: 'amount is bigger than the original transaction' });
    res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(502);
    expect((await res.json()).note).toContain('amount is bigger than the original transaction');
    expect((await rowOf(o.id)).refund_requested_at).toBeNull();

    // Not in flight: a later press is sent, and records.
    refundAnswer = REFUNDED;
    res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refund_note: null });
    expect(refundCalls(o.tx)).toHaveLength(3);
  });

  it('NO answer → the outcome is UNKNOWN: kept in flight (a press within ten minutes → 409, no second call), every admin alerted; after ten minutes a person may press again', async () => {
    const o = await paidOrder({ chips: 1 });
    refundAnswer = () => { throw new TypeError('fetch failed'); };
    as('super');
    let res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, kind: 'unknown' });
    expect(body.note).toContain('לא התקבלה תשובה מ-PayPlus');
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ status: 'paid', refunded_at: null, refund_status: 'manual_required', refund_note: body.note });
    expect(row.refund_requested_at).not.toBeNull();
    const alerts = await alertsLike(`chip_refund_unknown:${o.id}:%`);
    expect(alerts.map((a) => a.user_id).sort()).toEqual(await activeAdmins());
    expect(alerts[0]!.title).toContain(`הזמנה ${o.number}`);

    // Pressed again at once: refused, and PayPlus is not asked a second time.
    refundAnswer = REFUNDED;
    res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('כבר נשלחה ל-PayPlus');
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect((await docsOf(o.id)).filter((r) => r.kind === 'credit')).toEqual([]);

    // Ten minutes on, with no answer recorded, a person may try again.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '11 minutes' where id = $1`, [o.id]);
    res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(200);
    expect(refundCalls(o.tx)).toHaveLength(2);
    expect(await rowOf(o.id)).toMatchObject({ refund_status: 'refunded', refund_requested_at: null });
  });

  it('a TEST order paid in the sandbox is refunded through the SANDBOX (its keys) — and never gets a document row', async () => {
    const t = await paidOrder({ isTest: true, chips: 2 });
    expect(await docsOf(t.id)).toEqual([]);
    as('super');
    const res = await refund(t.id, { reason: 'בדיקת זיכוי' });
    expect(res.status).toBe(200);
    expect(refundCalls(t.tx)).toHaveLength(1);
    expect(refundCalls(t.tx)[0]).toMatchObject({ origin: ORIGIN.sandbox, apiKey: DEV.api, secretKey: DEV.secret });
    expect(refundCalls(t.tx)[0]!.body).toMatchObject({ amount: t.total, initial_invoice: false });
    expect(await rowOf(t.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refunded_amount: t.total });
    expect(await docsOf(t.id)).toEqual([]);
    expect((await audits(t.id, 'refunded'))[0]!.metadata).toMatchObject({ env: 'sandbox' });
  });

  it('"דחה" of a card-paid order refunds through the same engine (via reject), with its credit row and the rejection message', async () => {
    const o = await paidOrder({ chips: 1 });
    const [invoice] = await docsOf(o.id);
    as('super');
    const res = await reject(o.id, { reason: 'אין מלאי צ׳יפים' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, refund_status: 'refunded', refund_label: CHIP_ORDER_REFUND_LABEL.refunded, refund_note: null });
    expect(refundCalls(o.tx)).toHaveLength(1);
    expect(refundCalls(o.tx)[0]!.body).toMatchObject({ amount: o.total, initial_invoice: false });
    expect(await rowOf(o.id)).toMatchObject({
      status: 'rejected', reject_reason: 'אין מלאי צ׳יפים', refund_via: 'reject', refund_status: 'refunded', refunded_by: users.super!.id,
      refunded_amount: o.total,
    });
    const credit = (await docsOf(o.id)).filter((r) => r.kind === 'credit');
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({ credit_of: invoice!.id, payment_method: 'card', amount: o.total });
    await runAfter();
    expect((await audits(o.id, 'rejected'))[0]!.metadata).toMatchObject({ reason: 'אין מלאי צ׳יפים', refund_status: 'refunded' });
    expect((await messagesOf(o.id)).map((m) => m.kind)).toEqual(['rejected', 'rejected']);

    // PayPlus refusing the refund of a rejection: the rejection stands, the refund is for a person.
    const o2 = await paidOrder({ chips: 1 });
    refundAnswer = () => reply(200, { results: { status: 'error', description: 'סירוב' }, data: { transaction: { status_code: '033' } } });
    const res2 = await reject(o2.id, { reason: 'אין מלאי צ׳יפים' });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ ok: true, refund_status: 'manual_required', refund_note: expect.stringContaining('סירוב') });
    expect(await rowOf(o2.id)).toMatchObject({ status: 'rejected', refund_status: 'manual_required', refunded_at: null });
    expect((await docsOf(o2.id)).filter((r) => r.kind === 'credit')).toEqual([]);
  });

  // ── Refunds PayPlus reports (the callback) ───────────────────────────────

  it('a signed Refund notice (000, more_info = the order number) is recorded ONCE — via payplus, with its credit row; the same notice again changes nothing', async () => {
    const o = await paidOrder({ chips: 2 });
    const [invoice] = await docsOf(o.id);
    const uid = `rfn-${RUN}-full`;
    const notice = refundNotice(uid, o.total, String(o.number));
    expect((await callback(notice, 'production')).status).toBe(200);
    const row = await rowOf(o.id);
    expect(row).toMatchObject({
      status: 'rejected', reject_reason: 'זיכוי', refunded_amount: o.total, refund_transaction_uid: uid, refund_via: 'payplus',
      refunded_by: null, refunded_by_name: null, refund_status: 'refunded', refund_requested_at: null,
    });
    const credit = (await docsOf(o.id)).filter((r) => r.kind === 'credit');
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({ payment_key: `refund:${uid}`, credit_of: invoice!.id, amount: o.total, payment_method: 'card' });
    expect(credit[0]!.details).toMatchObject({ via: 'payplus', refund_uid: uid });
    expect(await audits(o.id, 'refunded')).toHaveLength(1);
    expect((await audits(o.id, 'refunded'))[0]!.actor_user_id).toBeNull();
    // A production refund made outside the system: every admin is told (its chips were not disabled).
    expect((await alertsLike(`chip_refund_payplus:${uid}:%`)).map((a) => a.user_id).sort()).toEqual(await activeAdmins());
    expect(afterQueue).toHaveLength(1);
    await runAfter();
    expect((await messagesOf(o.id)).map((m) => m.kind)).toEqual(['refunded', 'refunded']);

    for (let i = 0; i < 2; i++) expect((await callback(notice, 'production')).status).toBe(200);
    expect((await docsOf(o.id)).filter((r) => r.kind === 'credit')).toHaveLength(1);
    expect(await audits(o.id, 'refunded')).toHaveLength(1);
    expect(afterQueue).toHaveLength(0);
    expect((await rowOf(o.id)).refunded_amount).toBe(o.total);
    expect(refundCalls()).toEqual([]);
  });

  it('the notice of OUR OWN refund (its uid is on the order) → "already": nothing new', async () => {
    const own = (await rowOf(r1.id)).refund_transaction_uid!;
    const tx = readPayPlusTransaction(refundNotice(own, r1.total, String(r1.number)))!;
    expect(await applyPayPlusRefundNotice(payplusConfigFor('production')!, tx)).toEqual({ kind: 'already' });
    expect((await callback(refundNotice(own, r1.total, String(r1.number)), 'production')).status).toBe(200);
    expect((await docsOf(r1.id)).filter((r) => r.kind === 'credit')).toHaveLength(1);
    expect(await audits(r1.id, 'refunded')).toHaveLength(1);
    expect(afterQueue).toHaveLength(0);
  });

  it('a notice that names no order → ignored, and ONE alert per admin (a repeat alerts nobody again)', async () => {
    const uid = `rfn-${RUN}-nonum`;
    unmatchedUids.push(uid);
    const tx = readPayPlusTransaction(refundNotice(uid, 55, null))!;
    expect(await applyPayPlusRefundNotice(payplusConfigFor('production')!, tx)).toEqual({ kind: 'ignored', why: 'no_order_number' });
    expect((await callback(refundNotice(uid, 55, null), 'production')).status).toBe(200);
    const alerts = await alertsLike(`chip_refund_unmatched:${uid}:%`);
    expect(alerts.map((a) => a.user_id).sort()).toEqual(await activeAdmins());
    expect(alerts[0]).toMatchObject({ source_entity_id: null });
    expect(afterQueue).toHaveLength(0);
  });

  it('a notice while OUR refund of that order is in flight → 503 (PayPlus sends it again), nothing recorded; once it is not in flight, it records', async () => {
    const o = await paidOrder({ chips: 1 });
    await pool.query(`update public.chip_orders set refund_requested_at = now() where id = $1`, [o.id]);
    const notice = refundNotice(`rfn-${RUN}-inflight`, o.total, String(o.number));
    const res = await callback(notice, 'production');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(await rowOf(o.id)).toMatchObject({ refunded_at: null, refund_status: null });
    expect((await docsOf(o.id)).filter((r) => r.kind === 'credit')).toEqual([]);

    await pool.query(`update public.chip_orders set refund_requested_at = null where id = $1`, [o.id]);
    expect((await callback(notice, 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ refund_via: 'payplus', refund_status: 'refunded' });
  });

  // Regression (review, 26/11): our refund call got NO answer (the outcome is
  // unknown, kept in flight for ten minutes). PayPlus's own signed notice of
  // that refund, arriving after the call is over, is recorded at once — it was
  // refused (503) for the rest of the window, and PayPlus's resending is not
  // documented.
  it('our "זיכוי" got no answer → PayPlus\'s own notice of that refund, once the call is over, is RECORDED (not 503); a notice that does not fit what is left still waits', async () => {
    const o = await paidOrder({ chips: 1 });
    refundAnswer = () => { throw new TypeError('fetch failed'); };
    as('super');
    const res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(502);
    expect((await res.json()).kind).toBe('unknown');
    expect((await rowOf(o.id)).refund_requested_at).not.toBeNull();
    // The call is long over (PayPlus's timeout is 20 seconds); still in flight.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '2 minutes' where id = $1`, [o.id]);

    // More than was charged: not that refund — it waits, nothing is recorded.
    expect((await callback(refundNotice(`rfn-${RUN}-unk-big`, o.total + 1, String(o.number)), 'production')).status).toBe(503);
    expect(await rowOf(o.id)).toMatchObject({ refunded_at: null, refund_status: 'manual_required' });

    const uid = `rfn-${RUN}-unk`;
    expect((await callback(refundNotice(uid, o.total, `refund:${o.number}`), 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({
      refunded_amount: o.total, refund_transaction_uid: uid, refund_status: 'refunded', refund_note: null, refund_requested_at: null,
    });
    const credit = (await docsOf(o.id)).filter((r) => r.kind === 'credit');
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({ payment_key: `refund:${uid}`, amount: o.total, payment_method: 'card' });
    // Recorded: a second "זיכוי" is refused, PayPlus is not asked again.
    refundAnswer = REFUNDED;
    expect((await refund(o.id, { reason: 'שוב' })).status).toBe(409);
    expect(refundCalls(o.tx)).toHaveLength(1);
  });

  // Regression (review, 26/11): PayPlus refunded, then recording it threw.
  it('PayPlus REFUNDED but recording it failed → never a 500: manual_required naming the refund, kept in flight, every admin alerted — no second refund call', async () => {
    const o = await paidOrder({ chips: 1 });
    rr.failNext = true;
    as('super');
    const res = await refund(o.id, { reason: 'ביטול' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, kind: 'manual_required' });
    const refundUid = `rf-${RUN}-${refundSeq}`;
    expect(body.note).toContain(refundUid);
    expect(body.note).toContain('אין לזכות שוב');
    const row = await rowOf(o.id);
    expect(row).toMatchObject({ refunded_at: null, refund_status: 'manual_required', refund_note: body.note });
    expect(row.refund_requested_at).not.toBeNull();
    const alerts = await alertsLike(`chip_refund_unrecorded:${refundUid}:%`);
    expect(alerts.map((a) => a.user_id).sort()).toEqual(await activeAdmins());
    expect(alerts[0]!.title).toContain(`הזמנה ${o.number}`);
    // Pressed again: refused — PayPlus is not asked a second time.
    expect((await refund(o.id, { reason: 'ביטול' })).status).toBe(409);
    expect(refundCalls(o.tx)).toHaveLength(1);
    // PayPlus's own notice of that refund then records it.
    await pool.query(`update public.chip_orders set refund_requested_at = now() - interval '2 minutes' where id = $1`, [o.id]);
    expect((await callback(refundNotice(refundUid, o.total, `refund:${o.number}`), 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ refund_transaction_uid: refundUid, refund_status: 'refunded', refund_requested_at: null });
  });

  it('two PARTIAL refunds reported for a production order add up; the second closes it; each is recorded once', async () => {
    const o = await paidOrder({ chips: 3 }); // 120
    const a = refundNotice(`rfn-${RUN}-pa`, 30, String(o.number));
    const b = refundNotice(`rfn-${RUN}-pb`, o.total - 30, String(o.number));
    expect((await callback(a, 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'paid', refund_status: 'partial', refunded_amount: 30 });
    expect((await callback(b, 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ status: 'rejected', refund_status: 'refunded', refunded_amount: o.total });
    // The second notice again: its credit row says it was recorded.
    expect((await callback(b, 'production')).status).toBe(200);
    expect(await rowOf(o.id)).toMatchObject({ refunded_amount: o.total });
    const credits = (await docsOf(o.id)).filter((r) => r.kind === 'credit');
    expect(credits.map((c) => [c.payment_key, c.amount])).toEqual([[`refund:rfn-${RUN}-pa`, 30], [`refund:rfn-${RUN}-pb`, o.total - 30]]);
    expect(await audits(o.id, 'refunded')).toHaveLength(2);
  });

  // Regression (found 25/11 night run): a TEST order has no credit document row
  // and refund_transaction_uid keeps only the FIRST refund's id — recordRefund
  // also checks the order's 'refunded' audit rows for the refund id.
  it('a TEST order — the same SECOND partial refund notice, delivered twice, is recorded only once', async () => {
    const t = await paidOrder({ isTest: true, chips: 3 }); // 120
    const a = refundNotice(`rfn-${RUN}-ta`, 20, String(t.number));
    const b = refundNotice(`rfn-${RUN}-tb`, 30, String(t.number));
    expect((await callback(a, 'sandbox')).status).toBe(200);
    expect((await callback(b, 'sandbox')).status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ refund_status: 'partial', refunded_amount: 50 });
    expect((await callback(b, 'sandbox')).status).toBe(200);
    expect(await audits(t.id, 'refunded')).toHaveLength(2);
    expect((await rowOf(t.id)).refunded_amount).toBe(50);
  });

  it('no request of this file ever left for anywhere but the PayPlus stub', () => {
    expect(elsewhere).toEqual([]);
  });
});

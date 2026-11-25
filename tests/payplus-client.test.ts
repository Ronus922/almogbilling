import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The PayPlus client (src/lib/payplus/client.ts): which keys and host a mode
// picks, what generateLink is asked for, how a callback is validated, and that
// neither key ever leaves the two request headers. No network: fetch is
// stubbed. The key values below are synthetic.

const fakeEnv: Record<string, string | undefined> = {};
vi.mock('@/env', () => ({ env: fakeEnv }));

const {
  PayPlusApiError, createHostedFieldsSession, hostedFieldsRequestBody, isApprovedCharge, lookupPaymentRequest,
  payplusConfig, readPayPlusTransaction, verifyPayPlusCallback,
} = await import('@/lib/payplus/client');

const DEV = { api: 'dev-api-key-000111', secret: 'dev-secret-key-222333', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-444555', secret: 'prod-secret-key-666777', page: '99999999-8888-7777-6666-555555555555' };

function setEnv(mode: string | undefined, opts: { dev?: boolean; prod?: boolean } = { dev: true, prod: true }) {
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  if (mode) fakeEnv.PAYPLUS_MODE = mode;
  if (opts.dev) Object.assign(fakeEnv, { PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page });
  if (opts.prod) Object.assign(fakeEnv, { PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page });
}

const SESSION_INPUT = {
  amount: 150,
  orderNumber: 1009,
  pageOrigin: 'https://example.test',
  callbackUrl: 'https://example.test/api/public/chip-order/payplus/callback',
  customer: { name: 'דנה בדיקה', email: 'dana@example.test', phone: '972539400001' },
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('payplusConfig — the mode picks the key set and the host', () => {
  it('sandbox → the DEV values on restapidev', () => {
    setEnv('sandbox');
    expect(payplusConfig()).toEqual({
      mode: 'sandbox', origin: 'https://restapidev.payplus.co.il', apiKey: DEV.api, secretKey: DEV.secret, pageUid: DEV.page,
    });
  });

  it('production → the PROD values on restapi', () => {
    setEnv('production');
    expect(payplusConfig()).toEqual({
      mode: 'production', origin: 'https://restapi.payplus.co.il', apiKey: PROD.api, secretKey: PROD.secret, pageUid: PROD.page,
    });
  });

  it('no mode, an unknown mode, or a missing value of the mode → not configured', () => {
    setEnv(undefined);
    expect(payplusConfig()).toBeNull();
    setEnv('live');
    expect(payplusConfig()).toBeNull();
    setEnv('sandbox', { prod: true });
    expect(payplusConfig()).toBeNull(); // the PROD values are never a fallback for sandbox
    setEnv('production', { dev: true });
    expect(payplusConfig()).toBeNull();
    setEnv('sandbox');
    delete fakeEnv.PAYPLUS_DEV_PAGE_UID;
    expect(payplusConfig()).toBeNull();
  });
});

describe('generateLink — a regular charge, one payment, hosted fields', () => {
  it('asks for J4, one payment, the order number in more_info, our callback, hosted fields', () => {
    setEnv('sandbox');
    const body = hostedFieldsRequestBody(payplusConfig()!, SESSION_INPUT);
    expect(body).toMatchObject({
      payment_page_uid: DEV.page,
      charge_method: 1,
      amount: 150,
      currency_code: 'ILS',
      payments: 1,
      payments_selected: 1,
      payments_credit: false,
      hide_payments_field: true,
      create_token: false,
      initial_invoice: false,
      more_info: '1009',
      refURL_callback: SESSION_INPUT.callbackUrl,
      send_failure_callback: true,
      hosted_fields: true,
      refURL_origin: 'https://example.test',
      allowed_charge_methods: ['credit-card'],
      sendEmailApproval: false,
      sendEmailFailure: false,
    });
    // Nothing of ours beyond the name, email and phone of whoever ordered.
    expect(body.customer).toEqual({ customer_name: 'דנה בדיקה', email: 'dana@example.test', phone: '972539400001' });
    expect(JSON.stringify(body)).not.toContain(DEV.api);
    expect(JSON.stringify(body)).not.toContain(DEV.secret);
  });

  it('sends the keys in the two headers only, to the host of the mode', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, {
      results: { status: 'success', code: 0 },
      data: { page_request_uid: 'aaaaaaaa-1111-2222-3333-444444444444', hosted_fields_uuid: 'bbbbbbbb-1111-2222-3333-444444444444', payment_page_link: 'https://paymentsdev.payplus.co.il/x' },
    }));
    const session = await createHostedFieldsSession(payplusConfig()!, SESSION_INPUT);
    expect(session).toEqual({ pageRequestUid: 'aaaaaaaa-1111-2222-3333-444444444444', hostedFieldsUuid: 'bbbbbbbb-1111-2222-3333-444444444444' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://restapidev.payplus.co.il/api/v1.0/PaymentPages/generateLink');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(DEV.api);
    expect(headers['secret-key']).toBe(DEV.secret);
    expect(String(init.body)).not.toContain(DEV.api);
    expect(String(init.body)).not.toContain(DEV.secret);
    expect(url).not.toContain(DEV.api);
  });

  it('production goes to the production host with the production keys', async () => {
    setEnv('production');
    fetchMock.mockResolvedValueOnce(reply(200, {
      results: { status: 'success' },
      data: { page_request_uid: 'aaaaaaaa-1111-2222-3333-444444444444', hosted_fields_uuid: 'bbbbbbbb-1111-2222-3333-444444444444' },
    }));
    await createHostedFieldsSession(payplusConfig()!, SESSION_INPUT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://restapi.payplus.co.il/api/v1.0/PaymentPages/generateLink');
    expect((init.headers as Record<string, string>)['api-key']).toBe(PROD.api);
  });

  it('a reply without hosted_fields_uuid is an error (hosted fields not enabled), not a session', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: { page_request_uid: 'aaaaaaaa-1111-2222-3333-444444444444' } }));
    await expect(createHostedFieldsSession(payplusConfig()!, SESSION_INPUT)).rejects.toThrow(/hosted_fields_uuid/);
  });

  it("PayPlus's refusal is carried as it was said — and never with a key in it", async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(403, { message: `API_KEY / SECRET_KEY ARE NOT ALLOWED FROM THIS IP (203.0.113.9) ${DEV.api} ${DEV.secret}` }));
    const err = await createHostedFieldsSession(payplusConfig()!, SESSION_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPlusApiError);
    const e = err as InstanceType<typeof PayPlusApiError>;
    expect(e.status).toBe(403);
    expect(e.message).toContain('NOT ALLOWED FROM THIS IP');
    expect(e.message).not.toContain(DEV.api);
    expect(e.message).not.toContain(DEV.secret);
    expect(JSON.stringify({ ...e, message: e.message, stack: e.stack })).not.toContain(DEV.secret);
  });

  it('no reply at all is an error with status 0 and no request detail', async () => {
    setEnv('sandbox');
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`connect failed with secret-key ${DEV.secret}`), { name: 'TypeError' }));
    const e = (await createHostedFieldsSession(payplusConfig()!, SESSION_INPUT).catch((x: unknown) => x)) as InstanceType<typeof PayPlusApiError>;
    expect(e.status).toBe(0);
    expect(e.message).not.toContain(DEV.secret);
  });
});

describe('verifyPayPlusCallback — user-agent "PayPlus" and hash = base64(HMAC-SHA256(secret, body))', () => {
  const secret = DEV.secret;
  const sign = (message: string, key = secret) => createHmac('sha256', key).update(message).digest('base64');
  const body = JSON.stringify({ transaction_type: 'Charge', transaction: { uid: 'tx-000001', status_code: '000', amount: 150, more_info: '1009' } });
  const check = (raw: string, headers: { userAgent: string | null; hash: string | null }) => verifyPayPlusCallback(secret, Buffer.from(raw, 'utf8'), headers);

  it('accepts the body exactly as it arrived', () => {
    expect(check(body, { userAgent: 'PayPlus', hash: sign(body) }).ok).toBe(true);
  });

  it('accepts the hash of the re-serialized body (the docs sample signs JSON.stringify of the parsed body)', () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2); // same content, other bytes
    expect(check(pretty, { userAgent: 'PayPlus', hash: sign(body) }).ok).toBe(true);
  });

  it('a Hebrew body is signed over its bytes', () => {
    const hebrew = JSON.stringify({ transaction: { uid: 'tx-000002', status_code: '000', amount: 1, more_info: '7' }, note: 'בדיקה / "מירכאות"' });
    expect(check(hebrew, { userAgent: 'PayPlus', hash: sign(hebrew) }).ok).toBe(true);
  });

  it('rejects another user-agent, a missing hash, an empty, non-JSON or non-object body', () => {
    expect(check(body, { userAgent: 'curl/8.5.0', hash: sign(body) })).toEqual({ ok: false, reason: 'user_agent' });
    expect(check(body, { userAgent: null, hash: sign(body) })).toEqual({ ok: false, reason: 'user_agent' });
    expect(check(body, { userAgent: 'PayPlus', hash: null })).toEqual({ ok: false, reason: 'no_hash' });
    expect(check('', { userAgent: 'PayPlus', hash: sign('') })).toEqual({ ok: false, reason: 'no_body' });
    expect(check('not json', { userAgent: 'PayPlus', hash: sign('not json') })).toEqual({ ok: false, reason: 'bad_json' });
    expect(check('"a string"', { userAgent: 'PayPlus', hash: sign('"a string"') })).toEqual({ ok: false, reason: 'bad_json' });
    expect(check('[1,2]', { userAgent: 'PayPlus', hash: sign('[1,2]') })).toEqual({ ok: false, reason: 'bad_json' });
  });

  it('rejects a broken signature, a signature under another key, and a body changed after signing', () => {
    const good = sign(body);
    const broken = `${good.slice(0, -2)}${good.endsWith('A=') ? 'B=' : 'A='}`;
    expect(check(body, { userAgent: 'PayPlus', hash: broken })).toEqual({ ok: false, reason: 'bad_hash' });
    expect(check(body, { userAgent: 'PayPlus', hash: sign(body, 'another-key') })).toEqual({ ok: false, reason: 'bad_hash' });
    const tampered = body.replace('"amount":150', '"amount":1');
    expect(check(tampered, { userAgent: 'PayPlus', hash: good })).toEqual({ ok: false, reason: 'bad_hash' });
    expect(check(body, { userAgent: 'PayPlus', hash: 'x' })).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('a body nested deeper than the serializer can walk is refused, not thrown', () => {
    const deep = `${'['.repeat(20000)}${']'.repeat(20000)}`;
    const nested = `{"a":${deep}}`;
    expect(() => check(nested, { userAgent: 'PayPlus', hash: 'x' })).not.toThrow();
    expect(check(nested, { userAgent: 'PayPlus', hash: 'x' }).ok).toBe(false);
  });
});

describe('readPayPlusTransaction — a whitelist of fields', () => {
  // The shape of the docs ("Transaction Callback Response"), with synthetic values.
  const payload = {
    transaction_type: 'Charge',
    transaction: {
      uid: 'dcb11c1e7-a1231-37cf-6311-f5111eeb69c7',
      payment_request_uid: 'ef76432c-769a-43a6-ba7a-6f70272539d8',
      number: 'fd138', type: 'internal_page', date: '2026-11-25 12:32:52',
      status_code: '000', amount: 150, currency: 'ILS', credit_terms: 'regular',
      payments: { number_of_payments: 1, first_payment_amount: 0, rest_payments_amount: 0 },
      approval_number: '002341', voucher_number: '15-901-901', more_info: '1009',
    },
    data: {
      customer_uid: '3bcc6b2d-b35a-62e1-72c1-318a79bfd1be',
      card_information: {
        card_holder_name: 'Test Holder', four_digits: '9844', expiry_month: '05', expiry_year: '30',
        card_bin: '532614', identification_number: '000000018',
      },
    },
  };

  it('reads the transaction, its order number, its session and the last four digits', () => {
    const tx = readPayPlusTransaction(payload)!;
    expect(tx).toEqual({
      uid: 'dcb11c1e7-a1231-37cf-6311-f5111eeb69c7',
      pageRequestUid: 'ef76432c-769a-43a6-ba7a-6f70272539d8',
      type: 'charge', statusCode: '000', amount: 150, currency: 'ILS',
      approvalNumber: '002341', moreInfo: '1009', payments: 1, last4: '9844', statusDescription: null,
    });
    expect(isApprovedCharge(tx)).toBe(true);
  });

  it('never carries the expiry, the BIN, the holder name or the ID number', () => {
    const text = JSON.stringify(readPayPlusTransaction(payload));
    for (const secretish of ['532614', '000000018', 'Test Holder', '"05"', '"30"']) expect(text).not.toContain(secretish);
  });

  it('the KIND is transaction_type — transaction.type ("internal_page") is never read as the kind', () => {
    const { transaction_type: _kind, ...withoutKind } = payload;
    void _kind;
    const tx = readPayPlusTransaction(withoutKind)!;
    expect(tx.type).toBeNull();
    // Status 000 without a stated kind is NOT an approved charge.
    expect(isApprovedCharge(tx)).toBe(false);
    expect(isApprovedCharge(readPayPlusTransaction({ ...payload, transaction_type: 'Refund' })!)).toBe(false);
  });

  it('a status code that arrives as the number 0, or as "0", is the approved code 000', () => {
    for (const code of [0, '0', '00', '000']) {
      expect(readPayPlusTransaction({ ...payload, transaction: { ...payload.transaction, status_code: code } })!.statusCode).toBe('000');
    }
    const refused = readPayPlusTransaction({ ...payload, transaction: { ...payload.transaction, status_code: '033', status_description: 'declined' } })!;
    expect(isApprovedCharge(refused)).toBe(false);
    expect(refused).toMatchObject({ statusCode: '033', statusDescription: 'declined' });
  });

  it('a payload without a usable transaction is nothing', () => {
    expect(readPayPlusTransaction({})).toBeNull();
    expect(readPayPlusTransaction(null)).toBeNull();
    expect(readPayPlusTransaction([payload])).toBeNull();
    expect(readPayPlusTransaction({ transaction: { uid: 'x' } })).toBeNull();
    expect(readPayPlusTransaction({ transaction: { uid: 'tx-000001', status_code: '000', amount: 'abc' } })).toBeNull();
    // An id the table could not hold (8–80 characters) is not a transaction of ours.
    expect(readPayPlusTransaction({ transaction: { uid: 'short', status_code: '000', amount: 1 } })).toBeNull();
    expect(readPayPlusTransaction({ transaction: { uid: 'x'.repeat(81), status_code: '000', amount: 1 } })).toBeNull();
  });

  it('ignores four digits that are not four digits, and reads the alternate names of the lookup reply', () => {
    const tx = readPayPlusTransaction({ ...payload, data: { card_information: { four_digits: '5326140280779844' } } })!;
    expect(tx.last4).toBeNull();
    const flat = readPayPlusTransaction({ transaction_uid: 'tx-flat-0001', transaction_type: 'Charge', status_code: '000', amount: '150.00', currency_code: 'ils', approval_num: '77', more_info: 1009, page_request_uid: 'aaaaaaaa-1111-2222-3333-444444444444' })!;
    expect(flat).toMatchObject({ uid: 'tx-flat-0001', type: 'charge', amount: 150, currency: 'ILS', approvalNumber: '77', moreInfo: '1009', pageRequestUid: 'aaaaaaaa-1111-2222-3333-444444444444' });
  });
});

describe('lookupPaymentRequest — the server-side lookup', () => {
  const UID = 'aaaaaaaa-1111-2222-3333-444444444444';
  it('returns the transactions of the reply, once each', async () => {
    setEnv('sandbox');
    const tx = { uid: 'tx-000009', payment_request_uid: UID, status_code: '000', amount: 150, currency: 'ILS', more_info: '1009', transaction_type: 'Charge' };
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: { ...tx, related_transactions: [tx] } }));
    const found = await lookupPaymentRequest(payplusConfig()!, UID);
    expect(found.kind).toBe('transactions');
    if (found.kind !== 'transactions') return;
    expect(found.transactions).toHaveLength(1);
    expect(found.transactions[0]).toMatchObject({ uid: 'tx-000009', statusCode: '000', amount: 150, moreInfo: '1009', type: 'charge' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://restapidev.payplus.co.il/api/v1.0/PaymentPages/ipn');
    expect(JSON.parse(String(init.body))).toMatchObject({ payment_request_uid: UID });
  });

  it('PayPlus answered with no transaction → an empty list (nothing was charged)', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: {} }));
    expect(await lookupPaymentRequest(payplusConfig()!, UID)).toEqual({ kind: 'transactions', transactions: [] });
  });

  it('a refusal, an error or an unreadable answer is "unknown" — never "nothing was charged"', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(403, { message: `API_KEY / SECRET_KEY ARE NOT ALLOWED FROM THIS IP (203.0.113.9) ${DEV.secret}` }));
    const refused = await lookupPaymentRequest(payplusConfig()!, UID);
    expect(refused).toMatchObject({ kind: 'unknown', status: 403 });
    expect(JSON.stringify(refused)).not.toContain(DEV.secret);
    fetchMock.mockResolvedValueOnce(reply(422, { results: { status: 'error', description: 'x' } }));
    expect((await lookupPaymentRequest(payplusConfig()!, UID)).kind).toBe('unknown');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'error', description: 'not found' } }));
    expect(await lookupPaymentRequest(payplusConfig()!, UID)).toMatchObject({ kind: 'unknown', message: 'not found' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await lookupPaymentRequest(payplusConfig()!, UID)).toMatchObject({ kind: 'unknown', status: 0 });
  });
});

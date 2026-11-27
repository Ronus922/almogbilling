import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The PayPlus client (src/lib/payplus/client.ts): which keys and host each
// environment uses, what generateLink is asked for, how a callback is
// validated, and that neither key ever leaves the two request headers — plus
// the rules of WHO may pay by card in which environment
// (src/lib/chipOrders/cardPayment.ts, server.ts; 26/11/2026). No network:
// fetch is stubbed. The key values below are synthetic.

const fakeEnv: Record<string, string | undefined> = {};
vi.mock('@/env', () => ({ env: fakeEnv }));

const {
  PayPlusApiError, createHostedFieldsSession, disablePaymentRequest, hostedFieldsRequestBody, isApprovedCharge,
  lookupPaymentRequest, payloadFieldNames, payplusConfigFor, readPayPlusTransaction, refundByTransactionUid, verifyPayPlusCallback,
} = await import('@/lib/payplus/client');
const {
  cardChargingState, cardConfigFor, liveCardConfig, lookupConfigFor, orderMayPayByCard, testCardConfig,
} = await import('@/lib/chipOrders/cardPayment');
const { chipOrdersOpen } = await import('@/lib/chipOrders/server');
const { DEFAULT_CHIP_ORDER_SETTINGS } = await import('@/lib/chipOrders/model');

const DEV = { api: 'dev-api-key-000111', secret: 'dev-secret-key-222333', page: '11111111-2222-3333-4444-555555555555' };
const PROD = { api: 'prod-api-key-444555', secret: 'prod-secret-key-666777', page: '99999999-8888-7777-6666-555555555555' };
const DEV_KEYS = ['PAYPLUS_DEV_API_KEY', 'PAYPLUS_DEV_SECRET_KEY', 'PAYPLUS_DEV_PAGE_UID'] as const;
const PROD_KEYS = ['PAYPLUS_PROD_API_KEY', 'PAYPLUS_PROD_SECRET_KEY', 'PAYPLUS_PROD_PAGE_UID'] as const;

function setEnv(mode: string | undefined, opts: { dev?: boolean; prod?: boolean; live?: string } = { dev: true, prod: true }) {
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  if (mode) fakeEnv.PAYPLUS_MODE = mode;
  if (opts.live) fakeEnv.PAYPLUS_LIVE_CHARGING = opts.live;
  if (opts.dev) Object.assign(fakeEnv, { PAYPLUS_DEV_API_KEY: DEV.api, PAYPLUS_DEV_SECRET_KEY: DEV.secret, PAYPLUS_DEV_PAGE_UID: DEV.page });
  if (opts.prod) Object.assign(fakeEnv, { PAYPLUS_PROD_API_KEY: PROD.api, PAYPLUS_PROD_SECRET_KEY: PROD.secret, PAYPLUS_PROD_PAGE_UID: PROD.page });
}
/** Real charging ARMED: production mode, both key sets, the switch on. */
const armed = () => setEnv('production', { dev: true, prod: true, live: 'on' });

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

const SANDBOX_CFG = { mode: 'sandbox', origin: 'https://restapidev.payplus.co.il', apiKey: DEV.api, secretKey: DEV.secret, pageUid: DEV.page };
const PRODUCTION_CFG = { mode: 'production', origin: 'https://restapi.payplus.co.il', apiKey: PROD.api, secretKey: PROD.secret, pageUid: PROD.page };

describe('payplusConfigFor — each environment, with its own three values only', () => {
  it('sandbox → the DEV values on restapidev, whatever PAYPLUS_MODE says', () => {
    for (const mode of [undefined, 'sandbox', 'production']) {
      setEnv(mode);
      expect(payplusConfigFor('sandbox')).toEqual(SANDBOX_CFG);
    }
  });

  it('production → the PROD values on restapi, whatever PAYPLUS_MODE says', () => {
    for (const mode of [undefined, 'sandbox', 'production']) {
      setEnv(mode);
      expect(payplusConfigFor('production')).toEqual(PRODUCTION_CFG);
    }
  });

  it('the other environment\'s values are never a fallback; one missing value = that environment is not configured', () => {
    setEnv('sandbox', { prod: true });
    expect(payplusConfigFor('sandbox')).toBeNull();
    expect(payplusConfigFor('production')).toEqual(PRODUCTION_CFG);
    setEnv('production', { dev: true });
    expect(payplusConfigFor('production')).toBeNull();
    expect(payplusConfigFor('sandbox')).toEqual(SANDBOX_CFG);
    for (const key of DEV_KEYS) {
      setEnv('sandbox');
      delete fakeEnv[key];
      expect(payplusConfigFor('sandbox')).toBeNull();
      expect(payplusConfigFor('production')).toEqual(PRODUCTION_CFG);
    }
    for (const key of PROD_KEYS) {
      setEnv('production');
      delete fakeEnv[key];
      expect(payplusConfigFor('production')).toBeNull();
      expect(payplusConfigFor('sandbox')).toEqual(SANDBOX_CFG);
    }
    setEnv(undefined, {});
    expect(payplusConfigFor('sandbox')).toBeNull();
    expect(payplusConfigFor('production')).toBeNull();
  });
});

describe('who may pay by card — the test link in the sandbox, a real order only while real charging is armed', () => {
  it('real charging is armed only by PAYPLUS_MODE=production + the three PROD values + PAYPLUS_LIVE_CHARGING=on', () => {
    armed();
    expect(liveCardConfig()).toEqual(PRODUCTION_CFG);
    // The switch is OFF by default: unset, or anything but 'on'.
    armed();
    delete fakeEnv.PAYPLUS_LIVE_CHARGING;
    expect(liveCardConfig()).toBeNull();
    armed();
    fakeEnv.PAYPLUS_LIVE_CHARGING = 'off';
    expect(liveCardConfig()).toBeNull();
    // Not production mode.
    for (const mode of [undefined, 'sandbox']) {
      armed();
      if (mode) fakeEnv.PAYPLUS_MODE = mode;
      else delete fakeEnv.PAYPLUS_MODE;
      expect(liveCardConfig()).toBeNull();
    }
    // A PROD value missing — and the DEV values never stand in for one.
    for (const key of PROD_KEYS) {
      armed();
      delete fakeEnv[key];
      expect(liveCardConfig()).toBeNull();
    }
    setEnv('production', { dev: true, live: 'on' });
    expect(liveCardConfig()).toBeNull();
  });

  it('a TEST order always pays in the sandbox — whatever PAYPLUS_MODE and the switch say; no DEV values = no card step', () => {
    for (const mode of [undefined, 'sandbox', 'production']) {
      for (const live of [undefined, 'on', 'off']) {
        setEnv(mode, { dev: true, prod: true, live });
        expect(testCardConfig()).toEqual(SANDBOX_CFG);
        expect(cardConfigFor(true)).toEqual(SANDBOX_CFG);
      }
    }
    setEnv('production', { prod: true, live: 'on' });
    expect(testCardConfig()).toBeNull();
    expect(cardConfigFor(true)).toBeNull();
    expect(cardConfigFor(false)).toEqual(PRODUCTION_CFG); // a real order is unaffected
  });

  it('a REAL order pays only with the armed production configuration', () => {
    setEnv('production'); // the switch is not on
    expect(cardConfigFor(false)).toBeNull();
    armed();
    expect(cardConfigFor(false)).toEqual(PRODUCTION_CFG);
  });

  it('a session is looked up with its own environment\'s values, whether or not new charges are armed', () => {
    setEnv('sandbox'); // not armed
    expect(cardConfigFor(false)).toBeNull();
    expect(lookupConfigFor('production')).toEqual(PRODUCTION_CFG);
    expect(lookupConfigFor('sandbox')).toEqual(SANDBOX_CFG);
    setEnv(undefined, { dev: true });
    expect(lookupConfigFor('production')).toBeNull();
  });

  it('the public page takes orders only while the /settings switch is on AND real charging is armed', () => {
    const open = { ...DEFAULT_CHIP_ORDER_SETTINGS, ordersOpen: true };
    const closed = { ...DEFAULT_CHIP_ORDER_SETTINGS, ordersOpen: false };
    armed();
    expect(chipOrdersOpen(open)).toBe(true);
    expect(chipOrdersOpen(closed)).toBe(false);
    setEnv('production'); // every value, but the switch is off (the default)
    expect(chipOrdersOpen(open)).toBe(false);
    setEnv('sandbox', { dev: true, prod: true, live: 'on' }); // the sandbox never opens the page
    expect(chipOrdersOpen(open)).toBe(false);
    setEnv(undefined, {});
    expect(chipOrdersOpen(open)).toBe(false);
  });

  it('a session\'s environment must be the order\'s kind: the sandbox for a test order, production for a real one', () => {
    setEnv('production');
    const sandbox = payplusConfigFor('sandbox')!;
    const production = payplusConfigFor('production')!;
    const real = { is_test: false, source: 'web', status: 'pending_payment' as const };
    const test = { ...real, is_test: true };
    expect(orderMayPayByCard(sandbox, test)).toBe(true);
    expect(orderMayPayByCard(sandbox, real)).toBe(false);
    expect(orderMayPayByCard(production, real)).toBe(true);
    expect(orderMayPayByCard(production, test)).toBe(false);
    expect(orderMayPayByCard(production, { ...real, source: 'reception' })).toBe(false);
    expect(orderMayPayByCard(production, { ...real, status: 'paid' })).toBe(false);
  });

  it('cardChargingState tells /settings what is set — never a key', () => {
    armed();
    const state = cardChargingState();
    expect(state).toEqual({ mode: 'production', sandboxConfigured: true, productionConfigured: true, switchOn: true, live: true });
    for (const secret of [DEV.api, DEV.secret, PROD.api, PROD.secret]) expect(JSON.stringify(state)).not.toContain(secret);
    setEnv(undefined, { dev: true });
    expect(cardChargingState()).toEqual({ mode: null, sandboxConfigured: true, productionConfigured: false, switchOn: false, live: false });
    setEnv('production', { dev: true, live: 'on' }); // the switch alone arms nothing
    expect(cardChargingState()).toMatchObject({ switchOn: true, live: false, productionConfigured: false });
  });
});

describe('generateLink — a regular charge, one payment, hosted fields', () => {
  it('asks for J4, one payment, the order number in more_info, our callback, hosted fields — the card and the two wallets', () => {
    setEnv('sandbox');
    const body = hostedFieldsRequestBody(payplusConfigFor('sandbox')!, SESSION_INPUT);
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
      charge_default: 'credit-card',
      sendEmailApproval: false,
      sendEmailFailure: false,
    });
    // The card plus the wallets the SDK may draw next to the fields (26/11/2026);
    // the other methods are no longer hidden — there is no flag for it any more.
    expect(body.allowed_charge_methods).toEqual(['credit-card', 'google-pay', 'apple-pay']);
    expect(body).not.toHaveProperty('hide_other_charge_methods');
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
    const session = await createHostedFieldsSession(payplusConfigFor('sandbox')!, SESSION_INPUT);
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
    await createHostedFieldsSession(payplusConfigFor('production')!, SESSION_INPUT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://restapi.payplus.co.il/api/v1.0/PaymentPages/generateLink');
    expect((init.headers as Record<string, string>)['api-key']).toBe(PROD.api);
    expect((init.headers as Record<string, string>)['secret-key']).toBe(PROD.secret);
    expect(JSON.parse(String(init.body))).toMatchObject({ payment_page_uid: PROD.page });
  });

  it('a reply without hosted_fields_uuid is an error (hosted fields not enabled), not a session', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: { page_request_uid: 'aaaaaaaa-1111-2222-3333-444444444444' } }));
    await expect(createHostedFieldsSession(payplusConfigFor('sandbox')!, SESSION_INPUT)).rejects.toThrow(/hosted_fields_uuid/);
  });

  it("PayPlus's refusal is carried as it was said — and never with a key in it", async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(403, { message: `API_KEY / SECRET_KEY ARE NOT ALLOWED FROM THIS IP (203.0.113.9) ${DEV.api} ${DEV.secret}` }));
    const err = await createHostedFieldsSession(payplusConfigFor('sandbox')!, SESSION_INPUT).catch((e: unknown) => e);
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
    const e = (await createHostedFieldsSession(payplusConfigFor('sandbox')!, SESSION_INPUT).catch((x: unknown) => x)) as InstanceType<typeof PayPlusApiError>;
    expect(e.status).toBe(0);
    expect(e.message).not.toContain(DEV.secret);
  });
});

describe('disablePaymentRequest — PaymentPages/Disable/<uid>, best-effort', () => {
  const UID = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('POSTs an empty body to the environment\'s own host, the keys in the two headers only', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success', code: 0 } }));
    expect(await disablePaymentRequest(payplusConfigFor('production')!, UID)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://restapi.payplus.co.il/api/v1.0/PaymentPages/Disable/${UID}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({});
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(PROD.api);
    expect(headers['secret-key']).toBe(PROD.secret);
    expect(url).not.toContain(PROD.api);
    expect(String(init.body)).not.toContain(PROD.secret);

    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' } }));
    expect(await disablePaymentRequest(payplusConfigFor('sandbox')!, UID)).toBe(true);
    expect(fetchMock.mock.calls[1]![0]).toBe(`https://restapidev.payplus.co.il/api/v1.0/PaymentPages/Disable/${UID}`);
  });

  it('never throws: a refusal or no reply at all is false', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(404, { message: 'payment request not found' }));
    expect(await disablePaymentRequest(payplusConfigFor('sandbox')!, UID)).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await disablePaymentRequest(payplusConfigFor('sandbox')!, UID)).toBe(false);
  });

  it('a value that is not a payment request uid goes nowhere', async () => {
    setEnv('sandbox');
    for (const bad of ['', 'short', '../generateLink', `${UID}/x`, 'aaaaaaaa-1111-2222-3333-44444444444g', 'a'.repeat(65)]) {
      expect(await disablePaymentRequest(payplusConfigFor('sandbox')!, bad)).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('the payment session of a nested (callback) payload, and the names-only view of a payload', () => {
  const base = { transaction_type: 'Charge', transaction: { uid: 'tx-000777', status_code: '000', amount: 50, more_info: '1009' } };
  const UID = 'aaaaaaaa-1111-2222-3333-444444444444';

  it('is found wherever PayPlus puts it — and is null when the notice does not carry it', () => {
    expect(readPayPlusTransaction(base)!.pageRequestUid).toBeNull();
    expect(readPayPlusTransaction({ ...base, transaction: { ...base.transaction, payment_request_uid: UID } })!.pageRequestUid).toBe(UID);
    expect(readPayPlusTransaction({ ...base, transaction: { ...base.transaction, payment_page_request_uid: UID } })!.pageRequestUid).toBe(UID);
    expect(readPayPlusTransaction({ ...base, page_request_uid: UID })!.pageRequestUid).toBe(UID);
    expect(readPayPlusTransaction({ ...base, data: { page_request_uid: UID } })!.pageRequestUid).toBe(UID);
  });

  it('payloadFieldNames lists names only — no value of the payload appears', () => {
    const payload = { ...base, data: { card_information: { four_digits: '9844', identification_number: '123456782', expiry_month: '05' }, items: [{ name: 'secret item', price: 50 }] }, 'weird key!': 1 };
    const names = payloadFieldNames(payload);
    expect(names).toEqual(expect.arrayContaining(['transaction_type', 'transaction', 'transaction.uid', 'data.card_information', 'data.card_information.identification_number', 'data.items', 'data.items[].name', '<key>']));
    const text = JSON.stringify(names);
    for (const value of ['123456782', '9844', 'tx-000777', 'secret item', 'weird key', 'Charge', '1009']) expect(text).not.toContain(value);
    expect(payloadFieldNames(null)).toEqual([]);
    expect(payloadFieldNames(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 1]))).length).toBe(150);
  });
});

describe('lookupPaymentRequest — the server-side lookup', () => {
  const UID = 'aaaaaaaa-1111-2222-3333-444444444444';
  it('returns the transactions of the reply, once each', async () => {
    setEnv('sandbox');
    const tx = { uid: 'tx-000009', payment_request_uid: UID, status_code: '000', amount: 150, currency: 'ILS', more_info: '1009', transaction_type: 'Charge' };
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: { ...tx, related_transactions: [tx] } }));
    const found = await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID);
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
    expect(await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).toEqual({ kind: 'transactions', transactions: [] });
  });

  // The reply PaymentPages/ipn really gives (the sandbox, 25/11/2026) — its
  // shape with invented values: flat, the kind in `type`.
  const REAL_REPLY = {
    results: { status: 'success', code: 0, description: 'operation has been success' },
    data: {
      transaction_uid: 'bbbbbbbb-1111-2222-3333-444444444444', page_request_uid: UID, is_multiple_transaction: false,
      type: 'Charge', method: 'credit-card', number: 'AbCdEf1234', date: '2026-11-25 18:02:00', status: 'approved',
      status_code: '000', status_description: 'ok', amount: 50, currency: 'ILS', credit_terms: 'regular',
      number_of_payments: 1, approval_num: '0000001A', more_info: '1271', four_digits: '9844',
      expiry_month: '05', expiry_year: '30', identification_number: '123456782', card_bin: '532614',
      card_holder_name: 'Test Holder', token_uid: 'cccccccc-1111-2222-3333-444444444444', customer_email: 'x@example.com',
    },
  };

  it('reads the real (flat) reply: the kind is `type`, and it is an approved charge', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, REAL_REPLY));
    const found = await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID);
    expect(found.kind).toBe('transactions');
    if (found.kind !== 'transactions') return;
    expect(found.transactions).toHaveLength(1);
    const tx = found.transactions[0]!;
    expect(tx).toEqual({
      uid: 'bbbbbbbb-1111-2222-3333-444444444444', pageRequestUid: UID, type: 'charge', statusCode: '000', amount: 50,
      currency: 'ILS', approvalNumber: '0000001A', moreInfo: '1271', payments: 1, last4: '9844', statusDescription: 'ok',
    });
    expect(isApprovedCharge(tx)).toBe(true);
    // Nothing else of the card or its holder is carried on.
    for (const never of ['123456782', '532614', 'Test Holder', 'cccccccc-1111', 'x@example.com', 'expiry']) {
      expect(JSON.stringify(found)).not.toContain(never);
    }
  });

  it('a flat reply of another kind (a refund, a card check) is not an approved charge', async () => {
    setEnv('sandbox');
    for (const kind of ['Refund', 'Approval', 'Check']) {
      fetchMock.mockResolvedValueOnce(reply(200, { ...REAL_REPLY, data: { ...REAL_REPLY.data, type: kind } }));
      const found = await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID);
      if (found.kind !== 'transactions') throw new Error('expected transactions');
      expect(isApprovedCharge(found.transactions[0]!)).toBe(false);
    }
  });

  it('"can-not-find-payment_request_uid" is PayPlus saying the session has no transaction — an empty list', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'error', code: 1, description: 'can-not-find-payment_request_uid' }, data: {} }));
    expect(await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).toEqual({ kind: 'transactions', transactions: [] });
    // Only that exact answer: the same words on a refused request stay "unknown".
    fetchMock.mockResolvedValueOnce(reply(403, { results: { status: 'error', description: 'can-not-find-payment_request_uid' } }));
    expect((await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).kind).toBe('unknown');
  });

  it('a refusal, an error or an unreadable answer is "unknown" — never "nothing was charged"', async () => {
    setEnv('sandbox');
    fetchMock.mockResolvedValueOnce(reply(403, { message: `API_KEY / SECRET_KEY ARE NOT ALLOWED FROM THIS IP (203.0.113.9) ${DEV.secret}` }));
    const refused = await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID);
    expect(refused).toMatchObject({ kind: 'unknown', status: 403 });
    expect(JSON.stringify(refused)).not.toContain(DEV.secret);
    fetchMock.mockResolvedValueOnce(reply(422, { results: { status: 'error', description: 'x' } }));
    expect((await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).kind).toBe('unknown');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'error', description: 'not found' } }));
    expect(await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).toMatchObject({ kind: 'unknown', message: 'not found' });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await lookupPaymentRequest(payplusConfigFor('sandbox')!, UID)).toMatchObject({ kind: 'unknown', status: 0 });
  });
});

describe('refundByTransactionUid — refunded only on a readable approval; a "success" it cannot read is UNKNOWN, never "refused"', () => {
  const ASK = { transactionUid: 'tx-refund-test-0001', amount: 80, moreInfo: 'refund:1042' };

  it('the documented reply (results success + data.transaction 000 with its uid) → refunded', async () => {
    setEnv('production');
    fetchMock.mockResolvedValueOnce(reply(200, {
      results: { status: 'success', code: 0 },
      data: { transaction: { uid: 'rf-uid-00000001', status_code: '000', amount: 80, approval_number: '0654321' } },
    }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK))
      .toEqual({ kind: 'refunded', refundUid: 'rf-uid-00000001', approvalNumber: '0654321', amount: 80 });
  });

  it('"success" with no readable refund transaction (flat fields, or an approval without its uid) → unknown', async () => {
    setEnv('production');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success', code: 0 }, data: { transaction_uid: 'rf-flat-0000001', status_code: '000' } }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'unknown', status: 200 });
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success', code: 0 }, data: { transaction: { status_code: '000', amount: 80 } } }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'unknown', status: 200 });
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success', code: 0 } }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'unknown', status: 200 });
  });

  it('a refusal stays a refusal: "success" with a declined code, an error status, or a 4xx; no reply / a 5xx is unknown', async () => {
    setEnv('production');
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'success' }, data: { transaction: { uid: 'rf-uid-00000002', status_code: '004' } } }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'refused', statusCode: '004' });
    fetchMock.mockResolvedValueOnce(reply(200, { results: { status: 'error', description: 'הזיכוי נדחה' } }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'refused', message: 'הזיכוי נדחה' });
    fetchMock.mockResolvedValueOnce(reply(422, { message: 'amount is bigger than the original transaction' }));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'refused' });
    fetchMock.mockResolvedValueOnce(reply(502, 'bad gateway'));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'unknown', status: 502 });
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    expect(await refundByTransactionUid(payplusConfigFor('production')!, ASK)).toMatchObject({ kind: 'unknown', status: 0 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Morning (Green Invoice) client (src/lib/morning/client.ts, 26/11/2026):
// the OAuth token of the building's API key, the Bearer header of every later
// call, the token cache and its single refresh on a 401, the configuration
// rules, the reading of a created document, and the errors — which never carry
// the key. No network: fetch is a stub that answers by URL. The key values
// below are synthetic.

const fakeEnv: Record<string, string | undefined> = {};
vi.mock('@/env', () => ({ env: fakeEnv }));

const {
  createDocument, morningConfig, MorningApiError, readBusinessProfile, searchDocuments, __resetMorningTokenForTests,
} = await import('@/lib/morning/client');
const { chooseDocumentType } = await import('@/lib/morning/documents');

const KEY_ID = 'morning-key-id-test-7f3a91';
const KEY_SECRET = 'morning-key-secret-test-c48d20e5';
const HOST = {
  production: { token: 'https://api.morning.co/idp/v1/oauth/token', api: 'https://api.greeninvoice.co.il/api/v1' },
  sandbox: { token: 'https://api.sandbox.morning.dev/idp/v1/oauth/token', api: 'https://sandbox.d.greeninvoice.co.il/api/v1' },
} as const;

function setEnv(over: Record<string, string | undefined> = {}) {
  for (const k of Object.keys(fakeEnv)) delete fakeEnv[k];
  Object.assign(fakeEnv, { MORNING_API_KEY_ID: KEY_ID, MORNING_API_KEY_SECRET: KEY_SECRET }, over);
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete fakeEnv[k];
}

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }
const sent: Sent[] = [];
/** Answers per URL path, consumed in order; the last one repeats. */
const answers = new Map<string, (() => Response | Promise<Response>)[]>();
let tokenSeq = 0;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  sent.push({ url, method: init?.method ?? 'GET', headers, body });
  const u = new URL(url);
  const key = u.pathname.endsWith('/idp/v1/oauth/token') ? 'token' : u.pathname.replace(/^\/api\/v1/, '') + u.search;
  const queue = answers.get(key);
  if (queue && queue.length > 0) {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next();
  }
  if (key === 'token') {
    tokenSeq += 1;
    return reply(200, { accessToken: `access-token-${tokenSeq}`, tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  }
  throw new Error(`no answer set for ${key} in the test`);
});
const answer = (key: string, ...fns: (() => Response | Promise<Response>)[]) => answers.set(key, fns);
const apiCalls = () => sent.filter((s) => !s.url.endsWith('/idp/v1/oauth/token'));
const tokenCalls = () => sent.filter((s) => s.url.endsWith('/idp/v1/oauth/token'));

beforeEach(() => {
  setEnv();
  __resetMorningTokenForTests();
  sent.length = 0;
  answers.clear();
  tokenSeq = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const DOC_BODY = { type: 320, lang: 'he', currency: 'ILS', income: [], payment: [] };
const CREATED = { id: 'doc-uuid-0001', number: 80010, type: 320, url: { origin: 'https://example.test/origin.pdf', he: 'https://example.test/he.pdf' } };

/** Every string a request carried outside the token request's body. */
function nothingCarriesTheKey() {
  for (const s of sent) {
    expect(s.url).not.toContain(KEY_ID);
    expect(s.url).not.toContain(KEY_SECRET);
    expect(JSON.stringify(s.headers)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(s.headers)).not.toContain(KEY_ID);
    if (!s.url.endsWith('/idp/v1/oauth/token')) expect(JSON.stringify(s.body ?? null)).not.toContain(KEY_SECRET);
  }
}

describe('morningConfig — both values, or nothing', () => {
  it('the key id AND the secret → production by default, sandbox only when MORNING_ENV says so', () => {
    expect(morningConfig()).toEqual({ mode: 'production', tokenUrl: HOST.production.token, apiBase: HOST.production.api, clientId: KEY_ID, clientSecret: KEY_SECRET });
    setEnv({ MORNING_ENV: 'production' });
    expect(morningConfig()?.mode).toBe('production');
    setEnv({ MORNING_ENV: 'sandbox' });
    expect(morningConfig()).toEqual({ mode: 'sandbox', tokenUrl: HOST.sandbox.token, apiBase: HOST.sandbox.api, clientId: KEY_ID, clientSecret: KEY_SECRET });
  });

  it('either value missing → null (nothing is attempted)', () => {
    setEnv({ MORNING_API_KEY_ID: undefined });
    expect(morningConfig()).toBeNull();
    setEnv({ MORNING_API_KEY_SECRET: undefined });
    expect(morningConfig()).toBeNull();
    setEnv({ MORNING_API_KEY_ID: undefined, MORNING_API_KEY_SECRET: undefined, MORNING_ENV: 'sandbox' });
    expect(morningConfig()).toBeNull();
    setEnv({ MORNING_API_KEY_SECRET: '' });
    expect(morningConfig()).toBeNull();
  });
});

describe('the token — client credentials in a JSON body, then Bearer on every call', () => {
  it('POSTs {grant_type, client_id, client_secret} as JSON to the IdP of the mode; the API call carries "Bearer <accessToken>"', async () => {
    answer('/documents', () => reply(201, CREATED));
    await createDocument(morningConfig()!, DOC_BODY);
    expect(tokenCalls()).toHaveLength(1);
    const t = tokenCalls()[0]!;
    expect(t.url).toBe(HOST.production.token);
    expect(t.method).toBe('POST');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.body).toEqual({ grant_type: 'client_credentials', client_id: KEY_ID, client_secret: KEY_SECRET });
    expect(t.headers.authorization).toBeUndefined();

    expect(apiCalls()).toHaveLength(1);
    const c = apiCalls()[0]!;
    expect(c.url).toBe(`${HOST.production.api}/documents`);
    expect(c.method).toBe('POST');
    expect(c.headers.authorization).toBe('Bearer access-token-1');
    expect(c.headers['content-type']).toBe('application/json');
    expect(c.body).toEqual(DOC_BODY);
    nothingCarriesTheKey();
  });

  it('the sandbox uses the sandbox IdP and the sandbox API host', async () => {
    setEnv({ MORNING_ENV: 'sandbox' });
    answer('/documents', () => reply(201, CREATED));
    await createDocument(morningConfig()!, DOC_BODY);
    expect(tokenCalls().map((s) => s.url)).toEqual([HOST.sandbox.token]);
    expect(apiCalls().map((s) => s.url)).toEqual([`${HOST.sandbox.api}/documents`]);
    nothingCarriesTheKey();
  });

  it('the token is cached: three calls, one token request', async () => {
    answer('/documents', () => reply(201, CREATED));
    const cfg = morningConfig()!;
    for (let i = 0; i < 3; i++) await createDocument(cfg, DOC_BODY);
    expect(tokenCalls()).toHaveLength(1);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual(['Bearer access-token-1', 'Bearer access-token-1', 'Bearer access-token-1']);
  });

  it('a token about to expire (under two minutes left) is not reused; another key id gets its own token', async () => {
    answer('token', () => reply(200, { accessToken: 'short-lived', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 60 }),
      () => reply(200, { accessToken: 'fresh', tokenType: 'Bearer', expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
    answer('/documents', () => reply(201, CREATED));
    await createDocument(morningConfig()!, DOC_BODY);
    await createDocument(morningConfig()!, DOC_BODY);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual(['Bearer short-lived', 'Bearer fresh']);
    expect(tokenCalls()).toHaveLength(2);

    setEnv({ MORNING_API_KEY_ID: 'another-key-id-0000' });
    await createDocument(morningConfig()!, DOC_BODY);
    expect(tokenCalls()).toHaveLength(3);
    expect(tokenCalls()[2]!.body).toMatchObject({ client_id: 'another-key-id-0000' });
  });

  it('a 401 from the API re-authenticates ONCE and retries with the new token', async () => {
    answer('/documents', () => reply(401, { errorCode: 401, errorMessage: 'גישה נדחתה, נא להתחבר מחדש.' }), () => reply(201, CREATED));
    const issued = await createDocument(morningConfig()!, DOC_BODY);
    expect(issued.id).toBe(CREATED.id);
    expect(tokenCalls()).toHaveLength(2);
    expect(apiCalls().map((c) => c.headers.authorization)).toEqual(['Bearer access-token-1', 'Bearer access-token-2']);
  });

  it('…and a second 401 is an error (status 401, an auth problem) — no third attempt', async () => {
    answer('/documents', () => reply(401, { errorCode: 401, errorMessage: 'גישה נדחתה' }));
    const e = await createDocument(morningConfig()!, DOC_BODY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MorningApiError);
    expect(e).toMatchObject({ status: 401, endpoint: '/documents', retryable: false, authProblem: true });
    expect(apiCalls()).toHaveLength(2);
    expect(tokenCalls()).toHaveLength(2);
  });

  it('the token reply without accessToken, or the IdP refusing the key, is an error of the token endpoint', async () => {
    answer('token', () => reply(200, { tokenType: 'Bearer' }));
    let e = await createDocument(morningConfig()!, DOC_BODY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MorningApiError);
    expect(e).toMatchObject({ endpoint: 'token' });
    expect(apiCalls()).toHaveLength(0);

    __resetMorningTokenForTests();
    answer('token', () => reply(401, { error: 'invalid_client', error_description: `Missing or incorrect client_id ${KEY_ID} / ${KEY_SECRET}` }));
    e = await createDocument(morningConfig()!, DOC_BODY).catch((x: unknown) => x);
    expect(e).toMatchObject({ endpoint: 'token', status: 401, code: 'invalid_client', authProblem: true, retryable: false });
    expect((e as Error).message).toContain('Missing or incorrect client_id');
    expect((e as Error).message).not.toContain(KEY_ID);
    expect((e as Error).message).not.toContain(KEY_SECRET);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe('createDocument — what Morning answered', () => {
  it('reads id, number (as text) and url.origin; the type falls back to the body', async () => {
    answer('/documents', () => reply(201, CREATED));
    expect(await createDocument(morningConfig()!, DOC_BODY)).toEqual({ type: 320, id: 'doc-uuid-0001', number: '80010', url: 'https://example.test/origin.pdf' });

    answer('/documents', () => reply(201, { id: 'doc-uuid-0002', number: '80011', url: { he: 'https://example.test/he-only.pdf' } }));
    expect(await createDocument(morningConfig()!, { ...DOC_BODY, type: 400 })).toEqual({ type: 400, id: 'doc-uuid-0002', number: '80011', url: 'https://example.test/he-only.pdf' });

    answer('/documents', () => reply(201, { id: 'doc-uuid-0003', number: 7 }));
    expect(await createDocument(morningConfig()!, { ...DOC_BODY, type: 330 })).toEqual({ type: 330, id: 'doc-uuid-0003', number: '7', url: null });
  });

  it('a reply with no id or no number is an error, not a document', async () => {
    for (const bad of [{ number: 80012 }, { id: 'doc-uuid-0004' }, { id: 'doc-uuid-0005', number: 'abc' }, {}]) {
      answer('/documents', () => reply(201, bad));
      const e = await createDocument(morningConfig()!, DOC_BODY).catch((x: unknown) => x);
      expect(e, JSON.stringify(bad)).toBeInstanceOf(MorningApiError);
      expect(e).toMatchObject({ endpoint: '/documents', status: 200 });
    }
  });
});

describe('errors — status, Morning\'s own code, retryable only for 0 / 429 / 5xx, and never the key', () => {
  const failWith = async (fn: () => Response | Promise<Response>) => {
    answer('/documents', fn);
    return (await createDocument(morningConfig()!, DOC_BODY).catch((x: unknown) => x)) as InstanceType<typeof MorningApiError>;
  };

  it('a validation refusal (400 + errorCode) is not retryable; Morning\'s words and code are kept', async () => {
    const e = await failWith(() => reply(400, { errorCode: 2403, errorMessage: 'סוג המסמך אינו זמין לעסק' }));
    expect(e).toBeInstanceOf(MorningApiError);
    expect(e).toMatchObject({ status: 400, code: '2403', retryable: false, authProblem: false, endpoint: '/documents' });
    expect(e.message).toBe('סוג המסמך אינו זמין לעסק');
    for (const status of [403, 404, 409, 422]) {
      expect(await failWith(() => reply(status, { errorCode: 1006, errorMessage: 'נא לחדש את המינוי.' }))).toMatchObject({ status, retryable: false });
    }
  });

  it('429 and 5xx are retryable; so is no reply at all (status 0)', async () => {
    expect(await failWith(() => reply(429, { errorMessage: 'too many' }))).toMatchObject({ status: 429, retryable: true });
    expect(await failWith(() => reply(500, 'oops'))).toMatchObject({ status: 500, retryable: true, code: null });
    expect(await failWith(() => reply(503, { message: 'unavailable' }))).toMatchObject({ status: 503, retryable: true });
    const e = await failWith(() => { throw Object.assign(new Error(`connect ECONNREFUSED with ${KEY_SECRET}`), { name: 'TypeError' }); });
    expect(e).toMatchObject({ status: 0, retryable: true, code: null });
    expect(e.message).toContain('TypeError');
    expect(e.message).not.toContain(KEY_SECRET);
  });

  it('Morning echoing the key back never puts it in an error message (or anywhere on the error)', async () => {
    for (const body of [
      { errorCode: 1, errorMessage: `bad key ${KEY_ID}:${KEY_SECRET}` },
      { error: 'x', error_description: `client ${KEY_ID} secret ${KEY_SECRET}` },
      `<html>proxy says ${KEY_SECRET} and ${KEY_ID}</html>`,
    ]) {
      const e = await failWith(() => reply(400, body));
      expect(e).toBeInstanceOf(MorningApiError);
      const all = JSON.stringify({ ...e, message: e.message, stack: e.stack });
      expect(all).not.toContain(KEY_SECRET);
      expect(all).not.toContain(KEY_ID);
      expect(e.message).toContain('[redacted]');
      expect(e.message.length).toBeLessThanOrEqual(300);
    }
    nothingCarriesTheKey();
  });
});

describe('searchDocuments and readBusinessProfile', () => {
  it('search: POST /documents/search with the types, the dates, the client and one page — the items read field by field', async () => {
    answer('/documents/search', () => reply(200, {
      total: 3,
      items: [
        { id: 'doc-a', number: 80010, type: 320, remarks: 'מזהה: CHAAAA1111', description: 'd', amount: 150, url: { origin: 'https://example.test/a.pdf' } },
        { id: 'doc-b', number: '80011', type: '400', remarks: null, amount: '52.5', url: { he: 'https://example.test/b.pdf' } },
        { number: 99 }, // no id → dropped
      ],
    }));
    const items = await searchDocuments(morningConfig()!, { types: [320], fromDate: '2026-11-25', toDate: '2026-11-26', clientName: 'דנה' });
    const call = apiCalls()[0]!;
    expect(call.url).toBe(`${HOST.production.api}/documents/search`);
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ type: [320], fromDate: '2026-11-25', toDate: '2026-11-26', clientName: 'דנה', page: 1, pageSize: 100 });
    expect(items).toEqual([
      { id: 'doc-a', number: '80010', type: 320, remarks: 'מזהה: CHAAAA1111', description: 'd', amount: 150, url: 'https://example.test/a.pdf' },
      { id: 'doc-b', number: '80011', type: 400, remarks: '', description: '', amount: 52.5, url: 'https://example.test/b.pdf' },
    ]);
  });

  it('profile: the business type, the exemption, the VAT rate and the listed types — each part best-effort', async () => {
    answer('/businesses/me', () => reply(200, { type: 1, exemption: false, name: 'בניין בדיקה' }));
    answer('/documents/info?type=320', () => reply(200, { exemption: false, vatRate: 0.18, number: 80013 }));
    answer('/documents/types?lang=he', () => reply(200, [{ id: 305, name: 'x' }, { id: 320, name: 'y' }, { id: '400', name: 'z' }]));
    expect(await readBusinessProfile(morningConfig()!)).toEqual({ businessType: 1, exemption: false, vatRate: 0.18, availableTypes: [305, 320, 400] });
    expect(apiCalls().map((c) => [c.method, c.url])).toEqual([
      ['GET', `${HOST.production.api}/businesses/me`],
      ['GET', `${HOST.production.api}/documents/info?type=320`],
      ['GET', `${HOST.production.api}/documents/types?lang=he`],
    ]);
    expect(apiCalls().every((c) => c.headers.authorization === 'Bearer access-token-1')).toBe(true);
  });

  it('profile: /businesses/me missing (404) and the other two failing → every part null, no throw', async () => {
    answer('/businesses/me', () => reply(404, { errorMessage: 'not found' }));
    answer('/documents/info?type=320', () => reply(400, { errorCode: 2403, errorMessage: 'x' }));
    answer('/documents/types?lang=he', () => reply(500, 'down'));
    expect(await readBusinessProfile(morningConfig()!)).toEqual({ businessType: null, exemption: null, vatRate: null, availableTypes: null });
    // documents/info's exemption is read even when /businesses/me said nothing.
    answer('/businesses/me', () => reply(404, {}));
    answer('/documents/info?type=320', () => reply(200, { exemption: true, vatRate: 0 }));
    answer('/documents/types?lang=he', () => reply(200, []));
    expect(await readBusinessProfile(morningConfig()!)).toEqual({ businessType: null, exemption: true, vatRate: 0, availableTypes: null });
  });

  // Regression (review, 26/11): a 403 of the legacy /businesses/me (a key the
  // token endpoint accepted) kept the document type undecided forever.
  it('profile: /businesses/me FORBIDDEN (403) → no throw: the exemption comes from documents/info, so the document type is decided', async () => {
    answer('/businesses/me', () => reply(403, { errorMessage: 'גישה אסורה' }));
    answer('/documents/info?type=320', () => reply(200, { exemption: false, vatRate: 0.18 }));
    answer('/documents/types?lang=he', () => reply(200, [{ id: 320 }, { id: 400 }]));
    const profile = await readBusinessProfile(morningConfig()!);
    expect(profile).toEqual({ businessType: null, exemption: false, vatRate: 0.18, availableTypes: [320, 400] });
    expect(chooseDocumentType(profile)).toMatchObject({ docType: 320, vatIncluded: true });
    // An exempt account answers the same way: a receipt.
    answer('/documents/info?type=320', () => reply(200, { exemption: true, vatRate: 0 }));
    expect(chooseDocumentType(await readBusinessProfile(morningConfig()!))).toMatchObject({ docType: 400, vatIncluded: false });
  });

  it('profile: forbidden on /businesses/me AND on documents/info → the 403 is thrown (the account refuses this key) — never read as "unknown"', async () => {
    answer('/businesses/me', () => reply(403, { errorMessage: 'גישה אסורה' }));
    answer('/documents/info?type=320', () => reply(403, { errorMessage: 'גישה אסורה' }));
    const e = await readBusinessProfile(morningConfig()!).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MorningApiError);
    expect(e).toMatchObject({ status: 403, authProblem: true, endpoint: '/businesses/me' });
    expect(apiCalls().map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/businesses/me', '/api/v1/documents/info']);
  });

  it('profile: the key refused (401 twice) is thrown — never read as "unknown"', async () => {
    answer('/businesses/me', () => reply(401, { errorMessage: 'גישה נדחתה' }));
    const e = await readBusinessProfile(morningConfig()!).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MorningApiError);
    expect(e).toMatchObject({ status: 401, authProblem: true });
    // Nothing further was asked with a refused key.
    expect(apiCalls().map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/businesses/me', '/api/v1/businesses/me']);
  });
});

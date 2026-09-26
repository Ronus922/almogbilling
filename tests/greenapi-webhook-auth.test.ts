import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { authenticateWebhook, bearerToken } from '@/lib/whatsapp-webhook-auth';

// F8 — the Green API inbound webhook authenticates on a header, not a query
// string. Transition contract (both ways in, until the instance is switched):
//   no auth → 401 · wrong header → 401 · right header → 200 (auth=header)
//   right legacy ?secret → 200 (auth=legacy-query) · wrong ?secret → 401
// The route is exercised for real; only its downstream (DB, inbox pipeline,
// queue, SSE, logger, env) is mocked. Body `{}` → "unknown instance" → 200 ack.

// vi.mock factories are hoisted above every import/const — the fixtures must be too.
const { TOKEN, LEGACY } = vi.hoisted(() => ({
  TOKEN: 'ci-only-webhook-token-0123456789abcdef0123456789abcdef',
  LEGACY: 'ci-only-legacy-secret-fedcba9876543210fedcba9876543210',
}));

vi.mock('@/env', () => ({ env: { GREENAPI_WEBHOOK_TOKEN: TOKEN, GREEN_API_WEBHOOK_SECRET: LEGACY } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));
vi.mock('@/lib/db', () => ({ getDbPool: vi.fn(), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('@/lib/db/chatMessages', () => ({ updateMessageStatusByExternalId: vi.fn() }));
vi.mock('@/lib/wa-queue/campaigns', () => ({ markRecipientDelivery: vi.fn() }));
vi.mock('@/lib/whatsapp-events', () => ({ emitWa: vi.fn() }));
vi.mock('@/lib/whatsapp-inbound', () => ({ processIncomingMessage: vi.fn(), processOutgoingMessage: vi.fn() }));
vi.mock('@/lib/db/whatsappInstances', () => ({
  getInstanceByGreenId: vi.fn(async () => null),
  updateInstanceState: vi.fn(),
}));

import { POST } from '@/app/api/webhooks/greenapi/route';
import { logger } from '@/lib/logger';
import { processIncomingMessage } from '@/lib/whatsapp-inbound';

function call(opts: { authorization?: string; query?: string; body?: string } = {}) {
  const url = `https://billing.test/api/webhooks/greenapi${opts.query ? `?secret=${encodeURIComponent(opts.query)}` : ''}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  return POST(new NextRequest(url, { method: 'POST', headers, body: opts.body ?? '{}' }));
}

const infoLines = () =>
  vi.mocked(logger.info).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[webhooks/greenapi]'));

beforeEach(() => vi.clearAllMocks());

describe('POST /api/webhooks/greenapi — authentication (F8 transition)', () => {
  it('no authentication → 401, nothing processed, nothing logged as accepted', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(processIncomingMessage).not.toHaveBeenCalled();
    expect(infoLines()).toEqual([]);
  });

  it('wrong header → 401 (wrong token, the legacy secret as bearer, other scheme)', async () => {
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${LEGACY}` })).status).toBe(401);
    expect((await call({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await call({ authorization: TOKEN })).status).toBe(401);
    expect(infoLines()).toEqual([]);
  });

  it('right header → 200, and the accepted-request log says auth=header (no value)', async () => {
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const lines = infoLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('auth=header');
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('right legacy ?secret → 200, logged as auth=legacy-query (no value)', async () => {
    const res = await call({ query: LEGACY });
    expect(res.status).toBe(200);
    const lines = infoLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('auth=legacy-query');
    expect(lines[0]).not.toContain(LEGACY);
  });

  it('wrong ?secret → 401 (wrong value, and the NEW token in the query is not accepted)', async () => {
    expect((await call({ query: 'nope' })).status).toBe(401);
    expect((await call({ query: TOKEN })).status).toBe(401);
    expect(infoLines()).toEqual([]);
  });

  it('a malformed body on an authenticated request is acked with 200 and logged with its auth method', async () => {
    const res = await call({ authorization: `Bearer ${TOKEN}`, body: '{not json' });
    expect(res.status).toBe(200);
    const warns = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    expect(warns.some((l) => l.includes('auth=header') && l.includes('malformed'))).toBe(true);
  });
});

describe('authenticateWebhook / bearerToken — the pure decision', () => {
  const expected = { token: TOKEN, legacySecret: LEGACY };

  it('header wins, then legacy query, else null; case-insensitive scheme, trimmed', () => {
    expect(authenticateWebhook({ authorization: `Bearer ${TOKEN}`, querySecret: null }, expected)).toBe('header');
    expect(authenticateWebhook({ authorization: `  bearer ${TOKEN}  `, querySecret: null }, expected)).toBe('header');
    expect(authenticateWebhook({ authorization: `Bearer ${TOKEN}`, querySecret: 'nope' }, expected)).toBe('header');
    expect(authenticateWebhook({ authorization: null, querySecret: LEGACY }, expected)).toBe('legacy-query');
    expect(authenticateWebhook({ authorization: 'Bearer nope', querySecret: LEGACY }, expected)).toBe('legacy-query');
    expect(authenticateWebhook({ authorization: null, querySecret: null }, expected)).toBeNull();
    expect(authenticateWebhook({ authorization: `Bearer ${LEGACY}`, querySecret: TOKEN }, expected)).toBeNull();
  });

  it('an unconfigured side never matches (empty expected ≠ empty provided)', () => {
    expect(authenticateWebhook({ authorization: 'Bearer ', querySecret: '' }, { token: '', legacySecret: '' })).toBeNull();
    expect(authenticateWebhook({ authorization: null, querySecret: LEGACY }, { token: TOKEN, legacySecret: '' })).toBeNull();
  });

  it('bearerToken extracts only a Bearer scheme', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBe('');
    expect(bearerToken('abc')).toBe('');
    expect(bearerToken(null)).toBe('');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

// isSmsConfigured() reads these four — see tests/portal-otp-channel.test.ts
// for that gate on its own.
const mockEnv = vi.hoisted(() => ({
  SMS_PROVIDER: '019' as string | undefined,
  SMS_USERNAME: 'yeadim70' as string | undefined,
  SMS_API_KEY: 'test-token' as string | undefined,
  SMS_SENDER: 'AlmogTower' as string | undefined,
}));
vi.mock('@/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { sendSms } from '@/lib/portal/sms';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('sendSms — 019sms adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockEnv.SMS_PROVIDER = '019';
    mockEnv.SMS_USERNAME = 'yeadim70';
    mockEnv.SMS_API_KEY = 'test-token';
    mockEnv.SMS_SENDER = 'AlmogTower';
  });

  it('refuses to send when not configured — no fetch at all', async () => {
    mockEnv.SMS_SENDER = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res).toEqual({ ok: false, error: 'sms_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the right shape: Bearer token, username+source+local phone, status 0 = success', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://019sms.co.il/api');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        sms: {
          user: { username: 'yeadim70' },
          source: 'AlmogTower',
          destinations: { phone: [{ _: '0541234567' }] },
          message: 'code 1234',
        },
      });
      return jsonResponse({ status: 0, message: 'SMS will be sent', shipment_id: 'abc' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a known provider status code to a specific Hebrew reason (515 — unverified sender)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 515, message: 'Unverified source' })));

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('לא מאומת');
  });

  it('falls back to the provider\'s own message for an unmapped status code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 714, message: 'invalid temp_bl value' })));

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('invalid temp_bl value');
  });

  it('surfaces a non-2xx HTTP response instead of silently treating it as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Service Unavailable', { status: 503 })));

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('HTTP 503');
  });

  it('reports the real network failure, never a bare "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND 019sms.co.il'); }));

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('getaddrinfo ENOTFOUND');
      expect(res.error).not.toBe('fetch failed');
    }
  });

  it('reports a timeout distinctly, not as a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => { throw new DOMException('signal timed out', 'TimeoutError'); }),
    );

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('timed out');
  });

  it('treats an unparseable body as a failure rather than assuming success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })));

    const res = await sendSms('+972541234567', 'code 1234');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('תשובה לא צפויה');
  });
});

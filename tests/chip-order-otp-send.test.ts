import { afterEach, describe, expect, it, vi } from 'vitest';

// POST /api/public/chip-order/otp/request ("שלח קוד אימות" on /chip-order),
// run for real down to the 019 HTTP call: the real phone normaliser
// (toPortalE164), the real shared send (sendPortalCode → sendSms → the 019
// request body), the real channel choice. Mocked: the database (rate-limit
// buckets, the OTP row, settings, test-mode token), the WhatsApp instance
// lookup, and the network (fetch). No DB, so it runs in every gate.
//
// 13/11/2026: Ronen's test order stopped at "שליחת הקוד נכשלה" — 019 answered
// status 4 (no credit: the 09/11 SMS broadcast used the whole balance). The
// code was right; these cases pin it: every spelling of an Israeli mobile
// reaches 019 as the same number, a provider refusal stays generic on screen
// and is logged in full on the server with the purpose, and the WhatsApp
// fallback never touches 019.

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
  issueCode: vi.fn(async () => ({ code: '482913' })),
  resendCooldownRemaining: vi.fn(async () => 0),
  isTestRequest: vi.fn(async () => true),
  getDefaultSendCreds: vi.fn(async () => ({ greenInstanceId: '7107000001', token: 'wa-token', apiUrl: 'https://7107.api.greenapi.com' })),
  sendWhatsAppMessage: vi.fn(async () => ({ idMessage: 'wa-1' })),
  loggerError: vi.fn(),
}));

vi.mock('@/env', () => ({
  env: {
    APP_URL: 'https://almog-haifa.co.il',
    SMS_PROVIDER: '019',
    SMS_USERNAME: 'test-user',
    SMS_API_KEY: 'test-token',
    SMS_SENDER: 'TestSender',
    ADMIN_ALERT_PHONE: undefined,
    BLLINK_ALERT_PHONE: undefined,
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.loggerError, child: vi.fn() },
}));
vi.mock('@/lib/auth/rateLimit', () => ({ checkRateLimit: h.checkRateLimit }));
vi.mock('@/lib/db/portal/otp', () => ({
  issueCode: h.issueCode,
  resendCooldownRemaining: h.resendCooldownRemaining,
}));
vi.mock('@/lib/db/appSettings', () => ({ getChipOrderSettings: vi.fn(async () => ({})) }));
// The page is closed (no Grow yet) — only the test link opens it, exactly
// Ronen's situation on 13/11/2026.
vi.mock('@/lib/chipOrders/server', () => ({
  chipOrdersOpen: () => false,
  CHIP_ORDER_PUBLIC_HEADERS: { 'Cache-Control': 'private, no-store' },
}));
vi.mock('@/lib/chipOrders/testMode', () => ({ isTestRequest: h.isTestRequest }));
vi.mock('@/lib/db/whatsappInstances', () => ({ getDefaultSendCreds: h.getDefaultSendCreds }));
vi.mock('@/lib/whatsapp', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp')>()),
  sendWhatsAppMessage: h.sendWhatsAppMessage,
}));

const { POST } = await import('@/app/api/public/chip-order/otp/request/route');
const { sendPortalCode } = await import('@/lib/portal/send');

const CANONICAL = '+972525460546';
const GENERIC_FAILURE = 'שליחת הקוד נכשלה. נסו שוב בעוד רגע.';

function request(body: Record<string, unknown>): Request {
  return new Request('https://almog-haifa.co.il/api/public/chip-order/otp/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7', host: 'almog-haifa.co.il' },
    body: JSON.stringify(body),
  });
}

/** fetch stub for 019: answers `answer` and records every request body. */
function stub019(answer: Record<string, unknown>) {
  const bodies: { sms: { destinations: { phone: { _: string }[] }; message: string } }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://019sms.co.il/api');
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, bodies };
}

const rateLimitKeys = () => h.checkRateLimit.mock.calls.map((c) => (c as unknown as [string])[0]);

describe('chip-order OTP send — one canonical phone, SMS through 019, WhatsApp fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ['+972 (as Ronen typed it)', '+972525460546'],
    ['05 (local)', '0525460546'],
    ['9725 (no plus)', '972525460546'],
    ['+972 with dashes and spaces', '+972-52-546 0546'],
  ])('%s → stored, rate-limited and sent as the same number; 019 status 0 = sent', async (_label, typed) => {
    const { fetchMock, bodies } = stub019({ status: 0, message: 'SMS will be sent', shipment_id: '1' });

    const res = await POST(request({ phone: typed }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true, channel: 'sms' });
    // The OTP row and every per-phone bucket use the canonical E.164.
    expect(h.issueCode).toHaveBeenCalledWith(CANONICAL, '203.0.113.7', 'chip_order');
    expect(h.resendCooldownRemaining).toHaveBeenCalledWith(CANONICAL, 'chip_order');
    const phoneKeys = rateLimitKeys().filter((k) => k.includes(':phone:'));
    expect(phoneKeys).toEqual([
      `chip-order:otp:phone:${CANONICAL}`,
      `chip-order:otp:phone:hour:${CANONICAL}`,
      `chip-order:otp:phone:day:${CANONICAL}`,
    ]);
    // 019 gets the local 05… form, once, with the chip-order heading.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies[0]!.sms.destinations.phone).toEqual([{ _: '0525460546' }]);
    expect(bodies[0]!.sms.message.split('\n')[0]).toBe('קוד האימות שלך להזמנת צ׳יפים:');
  });

  it('019 refuses (status 4, no credit) → 502 with the generic message only; the real reason is logged with purpose chip_order', async () => {
    stub019({ status: 4, message: 'Not enough credit' });

    const res = await POST(request({ phone: '+972525460546' }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body).toEqual({ ok: false, message: GENERIC_FAILURE });
    expect(JSON.stringify(body)).not.toMatch(/019|קרדיט|credit/i);
    expect(h.loggerError).toHaveBeenCalledWith('[portal] code send failed (sms)', {
      error: '019sms (4): אין מספיק קרדיט בחשבון 019',
      purpose: 'chip_order',
    });
    // The failed attempt still counted: every ceiling was checked before the
    // send and the code was issued — a provider failure loosens nothing.
    expect(rateLimitKeys()).toHaveLength(5);
    expect(h.issueCode).toHaveBeenCalledTimes(1);
    // The digits never reach a log line.
    expect(JSON.stringify(h.loggerError.mock.calls)).not.toContain('482913');
  });

  it('"שליחת הקוד בוואטסאפ במקום" → WhatsApp only, 019 never called (works with an empty 019 balance)', async () => {
    const { fetchMock } = stub019({ status: 4, message: 'Not enough credit' });

    const res = await POST(request({ phone: '0525460546', channel: 'whatsapp' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true, channel: 'whatsapp' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const sent = (h.sendWhatsAppMessage.mock.calls[0] as unknown as [{ chatId: string; message: string }])[0];
    expect(sent.chatId).toBe('972525460546@c.us');
    expect(sent.message).toContain('*482913*');
    expect(sent.message.split('\n')[0]).toBe('קוד האימות שלך להזמנת צ׳יפים:');
  });

  it('a non-mobile is refused before any bucket, row or send', async () => {
    const { fetchMock } = stub019({ status: 0 });

    const res = await POST(request({ phone: '048123456' }));

    expect(res.status).toBe(400);
    expect(h.checkRateLimit).not.toHaveBeenCalled();
    expect(h.issueCode).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('portal login shares the same send: the same 019 refusal is logged the same way, with purpose portal_login', async () => {
    stub019({ status: 4, message: 'Not enough credit' });

    const res = await sendPortalCode(CANONICAL, '482913', 'sms', 'almog-haifa.co.il');

    expect(res).toEqual({ ok: false, error: '019sms (4): אין מספיק קרדיט בחשבון 019', channel: 'sms' });
    expect(h.loggerError).toHaveBeenCalledWith('[portal] code send failed (sms)', {
      error: '019sms (4): אין מספיק קרדיט בחשבון 019',
      purpose: 'portal_login',
    });
  });
});

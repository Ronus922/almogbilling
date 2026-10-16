import { afterEach, describe, expect, it, vi } from 'vitest';

// src/lib/portal/send.ts dispatches the OTP by channel and builds each
// channel's message text. Mocked here: the two real transports (sendSms,
// sendWhatsAppMessage) and the WhatsApp instance lookup — this file is about
// send.ts's OWN logic (message shape, channel dispatch, NO auto-fallback),
// not the 019/Green API adapters themselves (covered in tests/portal-sms.test.ts).
const h = vi.hoisted(() => ({
  sendSms: vi.fn(),
  sendWhatsAppMessage: vi.fn(),
  getDefaultSendCreds: vi.fn(),
}));
vi.mock('@/env', () => ({ env: { APP_URL: 'https://almog-haifa.co.il', ADMIN_ALERT_PHONE: undefined, BLLINK_ALERT_PHONE: undefined } }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } }));
vi.mock('@/lib/portal/sms', () => ({ sendSms: h.sendSms }));
vi.mock('@/lib/whatsapp', () => ({ sendWhatsAppMessage: h.sendWhatsAppMessage }));
vi.mock('@/lib/db/whatsappInstances', () => ({ getDefaultSendCreds: h.getDefaultSendCreds }));

import { sendPortalCode } from '@/lib/portal/send';

const PHONE = '+972541234567';
const CODE = '123456';

describe('sendPortalCode — message shape + channel dispatch (no auto-fallback)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('sms: last line is the exact WebOTP shape, bound to APP_URL\'s domain — not a hardcoded value', async () => {
    h.sendSms.mockResolvedValue({ ok: true });
    const res = await sendPortalCode(PHONE, CODE, 'sms');

    expect(res).toEqual({ ok: true, channel: 'sms' });
    expect(h.sendSms).toHaveBeenCalledTimes(1);
    const [sentPhone, text] = h.sendSms.mock.calls[0] as [string, string];
    expect(sentPhone).toBe(PHONE);
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe(`@almog-haifa.co.il #${CODE}`);
    expect(text).toContain(CODE);
    expect(h.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('whatsapp: the code is bold (asterisks), no WebOTP line (Chrome only matches SMS)', async () => {
    h.getDefaultSendCreds.mockResolvedValue({ greenInstanceId: 'i1', token: 't1', apiUrl: undefined });
    h.sendWhatsAppMessage.mockResolvedValue(undefined);
    const res = await sendPortalCode(PHONE, CODE, 'whatsapp');

    expect(res).toEqual({ ok: true, channel: 'whatsapp' });
    const call = h.sendWhatsAppMessage.mock.calls[0][0] as { message: string };
    expect(call.message).toContain(`*${CODE}*`);
    expect(call.message).not.toContain('@almog-haifa.co.il');
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it('a failed SMS send is surfaced as a failure — NOT silently retried over WhatsApp', async () => {
    h.sendSms.mockResolvedValue({ ok: false, error: '019sms (515): שם השולח לא מאומת' });

    const res = await sendPortalCode(PHONE, CODE, 'sms');

    expect(res).toEqual({ ok: false, error: '019sms (515): שם השולח לא מאומת', channel: 'sms' });
    // Deliberate asymmetry with the broadcast SMS channel (wa-queue/sms.ts),
    // which DOES fall back automatically: here the resident decides, via
    // "שלח בוואטסאפ במקום" — a silent channel switch would be confusing (a
    // code arrives on the number but not the app the screen just promised).
    expect(h.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('no WhatsApp instance configured: whatsapp send fails without ever calling the provider', async () => {
    h.getDefaultSendCreds.mockResolvedValue(null);
    const res = await sendPortalCode(PHONE, CODE, 'whatsapp');
    expect(res).toEqual({ ok: false, error: 'no_whatsapp_instance', channel: 'whatsapp' });
    expect(h.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sms: an allowlisted request Host (the former domain) binds the WebOTP line to IT, not APP_URL', async () => {
    h.sendSms.mockResolvedValue({ ok: true });
    await sendPortalCode(PHONE, CODE, 'sms', 'billing.bios.co.il');
    const [, text] = h.sendSms.mock.calls[0] as [string, string];
    expect(text.split('\n').at(-1)).toBe(`@billing.bios.co.il #${CODE}`);
  });

  it('sms: an unrecognized request Host falls back to APP_URL\'s domain, not the raw header', async () => {
    h.sendSms.mockResolvedValue({ ok: true });
    await sendPortalCode(PHONE, CODE, 'sms', 'evil.example.com');
    const [, text] = h.sendSms.mock.calls[0] as [string, string];
    expect(text.split('\n').at(-1)).toBe(`@almog-haifa.co.il #${CODE}`);
  });
});

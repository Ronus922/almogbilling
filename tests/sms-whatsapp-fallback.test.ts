import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSmsWhatsappFallback } from '@/lib/wa-queue/sms';
import { Provider019 } from '@/lib/wa-queue/smsProvider';

// 08/11/2026 — the SMS broadcast's WhatsApp fallback is an explicit,
// per-campaign opt-in. These are the pure (no database) pieces of that rule;
// the end-to-end behaviour against a real queue is in wa-queue-sms.test.ts.

describe('parseSmsWhatsappFallback — the server\'s hard gate on the opt-in flag', () => {
  it('absent / null → false, on every channel (the safe default)', () => {
    for (const ch of ['sms', 'whatsapp', 'email'] as const) {
      expect(parseSmsWhatsappFallback(ch, undefined)).toEqual({ ok: true, value: false });
      expect(parseSmsWhatsappFallback(ch, null)).toEqual({ ok: true, value: false });
    }
  });

  it('explicit false is fine on every channel', () => {
    for (const ch of ['sms', 'whatsapp', 'email'] as const) {
      expect(parseSmsWhatsappFallback(ch, false)).toEqual({ ok: true, value: false });
    }
  });

  it('true is accepted only on an sms campaign', () => {
    expect(parseSmsWhatsappFallback('sms', true)).toEqual({ ok: true, value: true });
    expect(parseSmsWhatsappFallback('whatsapp', true)).toMatchObject({ ok: false });
    expect(parseSmsWhatsappFallback('email', true)).toMatchObject({ ok: false });
  });

  it('anything that is not a boolean is refused — "true", 1, "yes" never count as an opt-in', () => {
    for (const bad of ['true', 'yes', 1, 0, {}, []]) {
      expect(parseSmsWhatsappFallback('sms', bad)).toMatchObject({ ok: false });
    }
  });
});

describe('Provider019 — a rejection carries its real 019 code in the message', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const input = { username: 'u', token: 't', source: 'AlmogTower', localPhone: '0500000000', message: 'שלום' };

  it('515 (unverified sender name) → the code and the Hebrew reason both reach last_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 515, message: 'Sender not verified' }), { status: 200 })));
    const res = await new Provider019().send(input);
    expect(res).toMatchObject({ ok: false, status: 515 });
    if (res.ok) throw new Error('unreachable');
    expect(res.message).toContain('515');
    expect(res.message).toContain('שם השולח');
  });

  it('an unknown code falls back to 019\'s own message, still prefixed with the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 777, message: 'Something odd' }), { status: 200 })));
    const res = await new Provider019().send(input);
    if (res.ok) throw new Error('unreachable');
    expect(res.message).toBe('019sms 777: Something odd');
  });

  it('a success (status 0) is still a success, with the shipment id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 0, shipment_id: 'abc' }), { status: 200 })));
    expect(await new Provider019().send(input)).toEqual({ ok: true, providerMessageId: 'abc' });
  });
});

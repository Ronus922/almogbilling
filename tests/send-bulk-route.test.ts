import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

// POST /api/whatsapp/send-bulk (the debtors table's "שליחת WhatsApp") and the
// number's shared rate window (08/11/2026). Every real message first takes a
// slot (takeWindowSlot — tested against the real window in
// wa-queue-window-slot.test.ts); the message is sent only once it has one; a
// full window is announced as a "waiting" line; a client that leaves while the
// run waits stops it. The window itself is modelled here on the fake clock, so
// 30 messages run in no real time. Nothing is sent: sendAndRecordWhatsApp is a
// recorder.

interface WindowOpts { aborted?: () => boolean; onWait?: (ms: number) => void }

const h = vi.hoisted(() => ({
  sends: [] as { phone: string; at: number; slotsBefore: number }[],
  slots: [] as number[],
  take: vi.fn(),
  prune: vi.fn(async () => undefined),
  debtors: {} as Record<string, { apartment_number: string; phone_owner: string | null; phone_tenant: string | null }>,
  extras: [] as { debtor_id: string; phone: string }[],
}));

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/actor', () => ({ requirePermission: vi.fn(async () => ({ id: 'u1' })) }));
vi.mock('@/lib/auth/apiGuard', () => ({ authErrorResponse: vi.fn(() => null) }));
vi.mock('@/lib/db/debtors', () => ({ getDebtorContact: vi.fn(async (id: string) => h.debtors[id] ?? null) }));
vi.mock('@/lib/db/contactPeople', () => ({ listExtraRecipientsForDebtors: vi.fn(async () => h.extras) }));
vi.mock('@/lib/db/whatsappInstances', () => ({
  resolveSendCreds: vi.fn(async () => ({ id: 'instance-1', greenInstanceId: 'g', token: 't', apiUrl: 'u', mediaUrl: null })),
  InstanceNotConfiguredError: class extends Error {},
}));
vi.mock('@/lib/whatsapp', () => ({
  cleanPhoneField: (v: string | null) => (v ? v.replace(/\D/g, '') || null : null),
  normalizePhone: (local: string) => ({ phone: `972${local.replace(/^0/, '')}` }),
}));
vi.mock('@/lib/whatsapp-send', () => ({
  sendAndRecordWhatsApp: vi.fn(async (a: { phoneIntl: string }) => {
    h.sends.push({ phone: a.phoneIntl, at: Date.now(), slotsBefore: h.slots.length });
    return { ok: true };
  }),
}));
vi.mock('@/lib/db', () => ({ getDbPool: () => ({}) }));
vi.mock('@/lib/wa-queue/rate-limit', () => ({
  DEFAULT_WA_RATE_PER_MIN: 12,
  pruneSendLog: h.prune,
  takeWindowSlot: (...args: unknown[]) => h.take(...args),
}));

import { POST } from '@/app/api/whatsapp/send-bulk/route';

/** The window as the real takeWindowSlot behaves, on the fake clock: a slot is
 *  free when fewer than `per` were taken in the last 60s; otherwise announce the
 *  wait (at once, then every 10s) and poll once a second. */
function modelTheWindow() {
  h.take.mockImplementation(async (_q: unknown, _bucket: string, per: number, opts: WindowOpts) => {
    let waited = 0;
    for (;;) {
      if (opts.aborted?.()) return false;
      const now = Date.now();
      if (h.slots.filter((s) => s > now - 60_000).length < per) {
        h.slots.push(now);
        return true;
      }
      if (waited % 10_000 === 0) opts.onWait?.(waited);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      waited += 1000;
    }
  });
}

type Line = Record<string, unknown> & { type: string };

async function runRoute(ids: string[], abortAfterMs?: number): Promise<Line[]> {
  const ac = new AbortController();
  const req = new NextRequest('http://localhost/api/whatsapp/send-bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ debtor_ids: ids, message: 'שלום' }),
    signal: ac.signal,
  });
  const res = await POST(req);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    finished = true;
  })();
  if (abortAfterMs !== undefined) setTimeout(() => ac.abort(), abortAfterMs);
  for (let i = 0; i < 5000 && !finished; i++) await vi.advanceTimersByTimeAsync(1000);
  await reading;
  return buffer.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
}

function debtorsFor(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `d${i}`;
    h.debtors[id] = { apartment_number: String(i + 1), phone_owner: `05011${String(10000 + i)}`, phone_tenant: null };
    ids.push(id);
  }
  return ids;
}

/** Most sends in any 60-second stretch of the fake clock. */
function busiestMinute(times: number[]): number {
  return Math.max(0, ...times.map((t) => times.filter((s) => s > t - 60_000 && s <= t).length));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
  h.sends.length = 0;
  h.slots.length = 0;
  h.extras = [];
  for (const k of Object.keys(h.debtors)) delete h.debtors[k];
  h.take.mockReset();
  h.prune.mockClear();
  modelTheWindow();
});
afterEach(() => { vi.useRealTimers(); });

describe('POST /api/whatsapp/send-bulk — under the number\'s shared rate window', () => {
  it('30 recipients: a slot is taken before EVERY message, none goes out without one, and no minute passes 12', async () => {
    const ids = debtorsFor(30);
    const lines = await runRoute(ids);

    expect(h.take).toHaveBeenCalledTimes(30);          // one gate per real message
    expect(h.sends).toHaveLength(30);
    h.sends.forEach((s, k) => expect(s.slotsBefore).toBeGreaterThan(k)); // the k-th message had its slot first
    expect(busiestMinute(h.sends.map((s) => s.at))).toBeLessThanOrEqual(12);
    expect(lines.filter((l) => l.type === 'progress')).toHaveLength(30);
    expect(lines.at(-1)).toMatchObject({ type: 'summary', sent: 30, failed: 0, skipped: 0 });
    expect(h.prune).toHaveBeenCalledTimes(1);          // the bucket is tidied once the run is over
  });

  it('a full window is announced as "waiting" lines (at once, then about every 10 seconds) that carry the pace', async () => {
    const lines = await runRoute(debtorsFor(20));
    const waiting = lines.filter((l) => l.type === 'waiting');
    expect(waiting.length).toBeGreaterThan(1);
    expect(waiting[0]).toMatchObject({ type: 'waiting', index: 13, total: 20, waited_ms: 0, per_min: 12 });
    expect(waiting.every((w) => w.per_min === 12)).toBe(true);
    // every waiting line is followed (sooner or later) by the progress line that ends the wait
    expect(lines.at(-1)).toMatchObject({ type: 'summary', sent: 20 });
  });

  it('a short run that fits the window never says "waiting"', async () => {
    const lines = await runRoute(debtorsFor(5));
    expect(lines.some((l) => l.type === 'waiting')).toBe(false);
    expect(h.sends).toHaveLength(5);
  });

  it('a client that leaves while the run is waiting stops it: no further message, no slot taken', async () => {
    const ids = debtorsFor(30);
    // 12 messages are out by ~30s; the 13th is waiting for the window when the client goes at 45s
    await runRoute(ids, 45_000);
    expect(h.sends).toHaveLength(12);
    expect(h.slots).toHaveLength(12);
  });

  it('only a real message takes a slot: a debtor without a phone, and a number already messaged, do not', async () => {
    const ids = debtorsFor(3);
    h.debtors.d1.phone_owner = null;                                      // skipped: no phone
    h.extras = [{ debtor_id: 'd2', phone: h.debtors.d2.phone_owner! }];   // the same number again: skipped
    const lines = await runRoute(ids);

    expect(h.sends).toHaveLength(2);
    expect(h.take).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toMatchObject({ type: 'summary', sent: 2, skipped: 2 });
  });
});

describe('the single send, reminders and notifications stay outside the window', () => {
  // Decided with the owner on 08/11/2026: only the bulk send joins the window.
  for (const file of [
    'src/app/api/whatsapp/send/route.ts',
    'src/lib/whatsapp-send.ts',
    'src/lib/reminders/engine.ts',
    'src/services/notifications.ts',
    'src/services/createNotify.ts',
  ]) {
    it(`${file} does not use the window`, () => {
      expect(readFileSync(file, 'utf8')).not.toMatch(/takeWindowSlot|wa-queue\/rate-limit/);
    });
  }
});

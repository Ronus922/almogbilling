import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCampaign, startCampaign, getCampaign } from '@/lib/wa-queue/campaigns';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider, type SendInput, type SendResult } from '@/lib/wa-queue/provider';
import { MockSmsProvider } from '@/lib/wa-queue/smsProvider';
import { DEFAULT_WA_RATE_PER_MIN, takeWindowSlot } from '@/lib/wa-queue/rate-limit';
import { SMS_RATE_BUCKET, toIsraeliLocal } from '@/lib/wa-queue/sms';
import type { RecipientInput } from '@/lib/wa-queue/types';

// 08/11/2026 — takeWindowSlot: the wait-then-take gate for a caller that cannot
// be re-queued (the debtors table's bulk WhatsApp send). It is the queue's
// window — same table, same bucket, same unit — so a broadcast, an SMS
// broadcast's WhatsApp fallback and the bulk send running together on one
// number share ONE budget of DEFAULT_WA_RATE_PER_MIN a minute.
//
// The real window is 60 seconds of database time, so these tests run on a fake
// clock: every simulated second ages the window's rows by a second. The real
// seconds the test itself takes age them a little more, so "no minute passes 12"
// is checked on a 58-second stretch. Nothing is sent: MockProvider +
// MockSmsProvider; each test uses its own instance id as the window, removed by
// that exact id. Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
const made = { contacts: [] as string[], campaigns: [] as string[], buckets: [] as string[] };
let contactId: string;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const newBucket = () => { const id = randomUUID(); made.buckets.push(id); return id; };
const phones = (base: number, count: number) => Array.from({ length: count }, (_, i) => `9725${base + i}`);
const recips = (list: string[]): RecipientInput[] =>
  list.map((p) => ({ contactId, debtorId: null, phoneIntl: p, payload: `שלום ${p}` }));

/** Age one bucket's window by `ms` of fake time. */
const age = (bucket: string, ms: number) => pool.query(
  `update public.wa_send_log set sent_at = sent_at - make_interval(secs => $2) where bucket = $1`, [bucket, ms / 1000]);

/** Most events in any `spanMs` stretch of the fake clock. */
function busiest(times: number[], spanMs: number): number {
  return Math.max(0, ...times.map((t) => times.filter((s) => s > t - spanMs && s <= t).length));
}

/** A WhatsApp provider that stamps every send with the fake clock. */
class StampedWhatsApp extends MockProvider {
  constructor(private readonly stamp: () => void) { super(); }
  async send(input: SendInput): Promise<SendResult> {
    this.stamp();
    return super.send(input);
  }
}

d('takeWindowSlot — one budget for everything that sends on a number', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name) values ($1, 'בדיקת חלון') returning id`,
      [`95${Date.now() % 10_000_000}`]);
    contactId = c.rows[0].id;
    made.contacts.push(contactId);
    await pool.query(`delete from public.wa_send_log where bucket = $1`, [SMS_RATE_BUCKET]);
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.campaigns.length) await pool.query(`delete from public.wa_campaigns where id = any($1::uuid[])`, [made.campaigns]);
    if (made.buckets.length) await pool.query(`delete from public.wa_send_log where bucket = any($1::text[])`, [made.buckets]);
    await pool.query(`delete from public.wa_send_log where bucket = $1`, [SMS_RATE_BUCKET]);
    if (made.contacts.length) await pool.query(`delete from public.contacts where id = any($1::uuid[])`, [made.contacts]);
    await pool.end();
  });

  it('30 messages one after another (2.5s apart, as the bulk send paces them): no minute passes 12; the wait is announced at once, then every 10s', async () => {
    const bucket = newBucket();
    let now = 0;
    const sleep = async (ms: number) => { now += ms; await age(bucket, ms); };
    const takes: number[] = [];
    const announced: number[] = [];

    for (let i = 0; i < 30; i++) {
      const got = await takeWindowSlot(pool, bucket, DEFAULT_WA_RATE_PER_MIN, { sleep, onWait: (w) => announced.push(w) });
      expect(got).toBe(true);
      takes.push(now);
      await sleep(2500); // the pause between two messages
    }

    expect(takes).toHaveLength(30);
    expect(busiest(takes, 58_000)).toBeLessThanOrEqual(DEFAULT_WA_RATE_PER_MIN);
    expect(Math.max(...takes)).toBeGreaterThanOrEqual(2 * 60_000 - 30_000); // 30 messages cannot fit in less than two windows
    expect(announced[0]).toBe(0);                                          // announced the moment the window was full
    expect(announced.every((w) => w % 10_000 === 0)).toBe(true);           // …then a heartbeat every 10s
    expect(announced.length).toBeGreaterThan(2);
  });

  it('gives up without taking a slot when the client is gone', async () => {
    const bucket = newBucket();
    await pool.query(`insert into public.wa_send_log (bucket) select $1 from generate_series(1, $2::int)`, [bucket, DEFAULT_WA_RATE_PER_MIN]);
    let polls = 0;
    const got = await takeWindowSlot(pool, bucket, DEFAULT_WA_RATE_PER_MIN, {
      aborted: () => polls++ >= 3, sleep: async () => {},
    });
    expect(got).toBe(false);
    expect(Number((await pool.query(`select count(*)::int c from public.wa_send_log where bucket = $1`, [bucket])).rows[0].c))
      .toBe(DEFAULT_WA_RATE_PER_MIN); // nothing added
  });

  it('a broadcast, an SMS fallback and the bulk send on ONE number together never pass the budget — and all three get through', async () => {
    const bucket = newBucket();
    const waList = phones(79000000, 15);
    const smsList = phones(79100000, 15);
    const BULK = 15;

    let now = 0;
    const stamps: number[] = [];
    const wa = new StampedWhatsApp(() => stamps.push(now));
    const sms = new MockSmsProvider({
      fail: Object.fromEntries(smsList.map((p) => [toIsraeliLocal(p) as string, { status: 515, message: '019sms 515: שם השולח לא מאומת' }])),
    });

    const before = await pool.query<{ value: unknown }>(`select value from public.app_settings where key = 'sms_rate_per_min'`);
    await pool.query(
      `insert into public.app_settings (key, value) values ('sms_rate_per_min', '120'::jsonb)
         on conflict (key) do update set value = excluded.value`);
    try {
      const waC = await createCampaign(pool, {
        channel: 'whatsapp', name: `win-wa-${uniq()}`, body: 'שלום', audience: { type: 'selection', roles: ['owners'] },
        instanceId: bucket, createdBy: null, recipients: recips(waList), ratePerMin: DEFAULT_WA_RATE_PER_MIN, dryRun: true,
      });
      const smsC = await createCampaign(pool, {
        channel: 'sms', name: `win-sms-${uniq()}`, body: 'שלום', audience: { type: 'selection', roles: ['owners'] },
        instanceId: bucket, createdBy: null, recipients: recips(smsList), ratePerMin: 20, dryRun: true, smsWhatsappFallback: true,
      });
      made.campaigns.push(waC.id, smsC.id);
      await startCampaign(pool, waC.id);
      await startCampaign(pool, smsC.id);

      const worker = new DeliveryWorker({
        pool, workerId: `win-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
        makeProviderFor: () => wa, makeSmsProviderFor: () => sms,
        resolveSmsCreds: () => ({ username: 'u', token: 't', source: 'AlmogTower' }),
      });

      // One try at the window, as the bulk send makes it between two messages:
      // a full window ends the try (nothing taken) instead of waiting.
      const bulkTry = async (): Promise<boolean> => {
        let polls = 0;
        return takeWindowSlot(pool, bucket, DEFAULT_WA_RATE_PER_MIN, { aborted: () => polls++ >= 1, sleep: async () => {} });
      };

      let bulkSent = 0;
      let bulkAt = -1;
      let lastReal = Date.now();
      for (let step = 0; step < 900; step++) {
        // One simulated second ages the window by exactly a second: the real
        // time the previous step took has already aged it, so only the rest is added.
        const real = Date.now();
        const spent = real - lastReal;
        lastReal = real;
        now += 1000;
        await age(bucket, Math.max(0, 1000 - spent));
        await pool.query(
          `update public.wa_campaign_recipients set next_attempt_at = now()
            where campaign_id = any($1::uuid[]) and status = 'pending'`, [[waC.id, smsC.id]]);
        const bulkNow = async () => {
          if (bulkSent < BULK && now - bulkAt >= 2500 && await bulkTry()) { bulkSent++; bulkAt = now; stamps.push(now); }
        };
        if (step % 2 === 0) { await worker.tick(); await bulkNow(); } else { await bulkNow(); await worker.tick(); }
        const left = await pool.query<{ c: number }>(
          `select count(*)::int c from public.wa_campaign_recipients where campaign_id = any($1::uuid[]) and status in ('pending','processing')`,
          [[waC.id, smsC.id]]);
        if (bulkSent === BULK && left.rows[0].c === 0) break;
      }

      expect(stamps).toHaveLength(waList.length + smsList.length + BULK); // everyone got through…
      expect(busiest(stamps, 58_000)).toBeLessThanOrEqual(DEFAULT_WA_RATE_PER_MIN); // …inside ONE budget
      expect(await getCampaign(pool, waC.id)).toMatchObject({ status: 'completed', sent_count: waList.length });
      expect(await getCampaign(pool, smsC.id)).toMatchObject({ status: 'completed', sent_count: smsList.length });
      expect(sms.sends).toHaveLength(smsList.length); // and the SMS leg ran once per person
      expect(bulkSent).toBe(BULK);
    } finally {
      if (before.rows[0]) {
        await pool.query(`update public.app_settings set value = $1::jsonb where key = 'sms_rate_per_min'`, [JSON.stringify(before.rows[0].value)]);
      } else {
        await pool.query(`delete from public.app_settings where key = 'sms_rate_per_min'`);
      }
    }
  }, 120_000); // ~330 simulated seconds, a few queries each
});

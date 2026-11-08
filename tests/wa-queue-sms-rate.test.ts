import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCampaign, startCampaign, getCampaign } from '@/lib/wa-queue/campaigns';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider } from '@/lib/wa-queue/provider';
import { MockSmsProvider } from '@/lib/wa-queue/smsProvider';
import { MockEmailTransport } from '@/lib/wa-queue/email';
import { DEFAULT_WA_RATE_PER_MIN } from '@/lib/wa-queue/rate-limit';
import { smsLegDoneError, readSmsRatePerMin, SMS_RATE_BUCKET, toIsraeliLocal } from '@/lib/wa-queue/sms';
import type { Campaign, Recipient, RecipientInput } from '@/lib/wa-queue/types';

// 08/11/2026 — the WhatsApp leg of an SMS broadcast's opt-in fallback obeys the
// SAME rate window as a WhatsApp broadcast on that instance. Before this, the
// leg only recorded its sends in wa_send_log and never checked them: every
// failed SMS went straight to WhatsApp at the SMS pace (20/min) instead of the
// WhatsApp pace (12/min), on a number that had already been blocked once.
//
// No real message of any kind is sent: MockSmsProvider + MockProvider +
// dry-run campaigns. Each test uses its OWN instance id as the WhatsApp bucket
// (a dry-run campaign never resolves the instance row), so the window is
// isolated and is cleaned up by that exact id.
//
// The database-backed block runs ONLY against a throwaway database
// (WA_TEST_DATABASE_URL), never prod.

const WA_NOTE = 'ממתין לתור הקצב של וואטסאפ';

describe('smsLegDoneError — recognises a re-queued recipient whose SMS leg is already finished', () => {
  const parked = `SMS: 019sms 515: שם השולח לא מאומת | WhatsApp (גיבוי): ${WA_NOTE}`;

  it('returns the SMS-leg error of a parked row', () => {
    expect(smsLegDoneError({ last_error: parked })).toBe('019sms 515: שם השולח לא מאומת');
  });

  it('also of a row re-queued after a WhatsApp 5xx / timeout / 429 — the SMS must not run again', () => {
    for (const waPart of ['mock transient 1/1', 'Green API timeout', '429 too many requests', 'HTTP 502']) {
      expect(smsLegDoneError({ last_error: `SMS: 019sms 515: x | WhatsApp (גיבוי): ${waPart}` })).toBe('019sms 515: x');
    }
  });

  it('is null for every row whose SMS leg has not run — it must still run', () => {
    expect(smsLegDoneError({ last_error: null })).toBeNull();
    expect(smsLegDoneError({ last_error: '' })).toBeNull();
    // an SMS-only failure never reached the WhatsApp leg
    expect(smsLegDoneError({ last_error: 'SMS: 019sms 515: x' })).toBeNull();
    // the success note of a delivered fallback is not a re-queue state
    expect(smsLegDoneError({ last_error: 'SMS נכשל (019sms 515: x) — נשלח בוואטסאפ במקום' })).toBeNull();
    // no SMS prefix
    expect(smsLegDoneError({ last_error: `x | WhatsApp (גיבוי): ${WA_NOTE}` })).toBeNull();
  });
});

const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

/** Everything this suite creates, removed by the exact ids/values it made. */
const made = { contacts: [] as string[], campaigns: [] as string[], buckets: [] as string[] };
let contactId: string;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

/** Israeli mobiles (9725 + 8 digits), unique per base. */
const phones = (base: number, count: number) => Array.from({ length: count }, (_, i) => `9725${base + i}`);

function recips(list: string[]): RecipientInput[] {
  return list.map((p) => ({ contactId, debtorId: null, phoneIntl: p, payload: `שלום ${p}` }));
}

/** An instance id that only this test uses → its own WhatsApp rate window. */
function newInstance(): string {
  const id = randomUUID();
  made.buckets.push(id);
  return id;
}

async function makeSmsCampaign(list: string[], instanceId: string, fallback: boolean): Promise<Campaign> {
  const c = await createCampaign(pool, {
    channel: 'sms', name: `smsrate-${uniq()}`, body: 'שלום',
    audience: { type: 'selection', roles: ['owners'] }, instanceId, createdBy: null,
    recipients: recips(list), ratePerMin: 20, dryRun: true, smsWhatsappFallback: fallback,
  });
  made.campaigns.push(c.id);
  return startCampaign(pool, c.id);
}

async function makeWaCampaign(list: string[], instanceId: string): Promise<Campaign> {
  const c = await createCampaign(pool, {
    channel: 'whatsapp', name: `warate-${uniq()}`, body: 'שלום',
    audience: { type: 'selection', roles: ['owners'] }, instanceId, createdBy: null,
    recipients: recips(list), ratePerMin: DEFAULT_WA_RATE_PER_MIN, dryRun: true,
  });
  made.campaigns.push(c.id);
  return startCampaign(pool, c.id);
}

function failAll019(list: string[]): MockSmsProvider {
  return new MockSmsProvider({
    fail: Object.fromEntries(list.map((p) => [toIsraeliLocal(p) as string, { status: 515, message: '019sms 515: שם השולח לא מאומת' }])),
  });
}

function makeWorker(sms: MockSmsProvider, wa: MockProvider, email?: MockEmailTransport) {
  return new DeliveryWorker({
    pool, workerId: `smsrate-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
    makeProviderFor: () => wa,
    makeSmsProviderFor: () => sms,
    resolveSmsCreds: () => ({ username: 'u', token: 't', source: 'AlmogTower' }),
    ...(email ? { makeEmailTransportFor: () => email } : {}),
  });
}

/** Tick until nothing is due right now (parked/paced items wait ~2s). */
async function pump(w: DeliveryWorker): Promise<void> {
  for (let i = 0; i < 100; i++) if (!(await w.tick())) return;
  throw new Error('pump: the worker never went idle');
}

const windowCount = async (bucket: string) =>
  Number((await pool.query(
    `select count(*)::int c from public.wa_send_log where bucket = $1 and sent_at > now() - interval '60 seconds'`,
    [bucket])).rows[0].c);

/** Let the 60s window pass without waiting, and make waiting items due. */
async function nextWindow(bucket: string, campaignIds: string[]): Promise<void> {
  await pool.query(`update public.wa_send_log set sent_at = sent_at - interval '61 seconds' where bucket = $1`, [bucket]);
  await pool.query(
    `update public.wa_campaign_recipients set next_attempt_at = now()
      where campaign_id = any($1::uuid[]) and status = 'pending'`, [campaignIds]);
}

async function rows(campaignId: string): Promise<Recipient[]> {
  return (await pool.query<Recipient>(
    `select * from public.wa_campaign_recipients where campaign_id = $1 order by phone_intl`, [campaignId])).rows;
}

async function withSmsRate<T>(rate: number, fn: () => Promise<T>): Promise<T> {
  const before = await pool.query<{ value: unknown }>(`select value from public.app_settings where key = 'sms_rate_per_min'`);
  await pool.query(
    `insert into public.app_settings (key, value) values ('sms_rate_per_min', $1::jsonb)
       on conflict (key) do update set value = excluded.value`, [JSON.stringify(rate)]);
  try {
    return await fn();
  } finally {
    if (before.rows[0]) {
      await pool.query(`update public.app_settings set value = $1::jsonb where key = 'sms_rate_per_min'`, [JSON.stringify(before.rows[0].value)]);
    } else {
      await pool.query(`delete from public.app_settings where key = 'sms_rate_per_min'`);
    }
  }
}

d('wa-queue — the SMS fallback leg shares the instance\'s WhatsApp rate window', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name) values ($1, 'בדיקת קצב SMS') returning id`,
      [`97${Date.now() % 10_000_000}`]);
    contactId = c.rows[0].id;
    made.contacts.push(contactId);
  });

  beforeEach(async () => {
    // The shared 019 window (a fixed bucket name) — must not carry over.
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

  it('DEFAULT_WA_RATE_PER_MIN is the wa_campaigns.rate_per_min column default (the pace of a regular broadcast)', async () => {
    const r = await pool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'wa_campaigns' and column_name = 'rate_per_min'`);
    expect(Number(r.rows[0].column_default)).toBe(DEFAULT_WA_RATE_PER_MIN);
  });

  it('(א) 30 recipients whose SMS fails: WhatsApp never passes 12/min, no SMS is repeated, nobody is sent twice', async () => {
    await withSmsRate(120, async () => {
      const list = phones(77000000, 30);
      const instance = newInstance();
      const sms = failAll019(list);
      const wa = new MockProvider();
      const c = await makeSmsCampaign(list, instance, true);
      const w = makeWorker(sms, wa);

      // Window 1: exactly the instance's budget goes out, the rest WAIT.
      await pump(w);
      expect(wa.sends).toHaveLength(DEFAULT_WA_RATE_PER_MIN);
      expect(await windowCount(instance)).toBe(DEFAULT_WA_RATE_PER_MIN);
      expect(sms.sends).toHaveLength(30); // every SMS attempted once…
      const first = await rows(c.id);
      const waiting = first.filter((r) => r.status === 'pending');
      expect(first.filter((r) => r.status === 'sent')).toHaveLength(12);
      expect(waiting).toHaveLength(18); // …and the 18 whose WhatsApp slot is taken are parked, not failed
      for (const r of waiting) {
        expect(r.error_class).toBe('rate_limited');
        expect(r.last_error).toContain('515');
        expect(r.last_error).toContain(WA_NOTE);
      }

      // Window 2, window 3: 12 more each time; the SMS leg is never re-run.
      await nextWindow(instance, [c.id]);
      await pump(w);
      expect(wa.sends).toHaveLength(24);
      expect(sms.sends).toHaveLength(30);

      await nextWindow(instance, [c.id]);
      await pump(w);
      expect(wa.sends).toHaveLength(30);
      expect(sms.sends).toHaveLength(30);
      expect(new Set(sms.sends.map((s) => s.localPhone)).size).toBe(30);   // one SMS per person
      expect(new Set(wa.sends.map((s) => s.chatId)).size).toBe(30);        // one WhatsApp per person

      const done = await rows(c.id);
      for (const r of done) {
        expect(r).toMatchObject({ status: 'sent', sent_channel: 'whatsapp', error_class: null });
        expect(r.last_error).toContain('נשלח בוואטסאפ במקום');
        expect(r.last_error).toContain('515');
        expect(r.last_error).not.toContain(WA_NOTE);
      }
      expect(await getCampaign(pool, c.id)).toMatchObject({ status: 'completed', sent_count: 30, failed_count: 0 });
    });
  });

  it('(ב) the fallback and a regular WhatsApp broadcast on the SAME instance share one budget — together never over 12/min', async () => {
    await withSmsRate(120, async () => {
      const smsList = phones(77100000, 30);
      const waList = phones(66000000, 30);
      const instance = newInstance();
      const sms = failAll019(smsList);
      const wa = new MockProvider();
      const smsC = await makeSmsCampaign(smsList, instance, true);
      const waC = await makeWaCampaign(waList, instance);
      const w = makeWorker(sms, wa);

      // 60 WhatsApp sends are owed in all; the window lets 12 out at a time.
      for (let window = 1; window <= 5; window++) {
        await pump(w);
        expect(wa.sends).toHaveLength(12 * window);          // never above the budget…
        expect(await windowCount(instance)).toBe(12);        // …and the budget is fully used
        await nextWindow(instance, [smsC.id, waC.id]);
      }
      await pump(w);
      expect(wa.sends).toHaveLength(60);
      expect(new Set(wa.sends.map((s) => s.chatId)).size).toBe(60);
      expect(sms.sends).toHaveLength(30); // the SMS leg ran once per recipient across all the waiting
      expect(await getCampaign(pool, smsC.id)).toMatchObject({ status: 'completed', sent_count: 30 });
      expect(await getCampaign(pool, waC.id)).toMatchObject({ status: 'completed', sent_count: 30 });
    });
  });

  it('(ג) the SMS leg keeps its own pace: a full WhatsApp window never holds an SMS back, and an SMS that goes through never touches WhatsApp', async () => {
    await withSmsRate(120, async () => {
      const ok = phones(77200000, 15);
      const bad = phones(77300000, 15);
      const instance = newInstance();
      // The instance's window is already full (another broadcast used it).
      await pool.query(`insert into public.wa_send_log (bucket) select $1 from generate_series(1, $2::int)`, [instance, DEFAULT_WA_RATE_PER_MIN]);
      const sms = failAll019(bad);
      const wa = new MockProvider();
      const c = await makeSmsCampaign([...ok, ...bad], instance, true);
      await pump(makeWorker(sms, wa));

      expect(sms.sends).toHaveLength(30);   // all 30 SMS went out, WhatsApp window or not
      expect(wa.sends).toHaveLength(0);     // and nothing over WhatsApp
      const got = await rows(c.id);
      expect(got.filter((r) => r.status === 'sent' && r.sent_channel === 'sms')).toHaveLength(15);
      expect(got.filter((r) => r.status === 'pending' && r.error_class === 'rate_limited')).toHaveLength(15);
      expect(await windowCount(instance)).toBe(DEFAULT_WA_RATE_PER_MIN); // unchanged: nothing added
    });
  });

  it('(ג) SMS WITHOUT the flag: same SMS pace as before, still zero WhatsApp, WhatsApp window untouched', async () => {
    const rate = await readSmsRatePerMin(pool);            // the real pace (our default 20)
    const list = phones(77400000, rate + 5);
    const instance = newInstance();
    const sms = failAll019(list);
    const wa = new MockProvider();
    const c = await makeSmsCampaign(list, instance, false);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(rate);                   // paced by the SMS window exactly as before
    expect(wa.sends).toHaveLength(0);
    expect(await windowCount(instance)).toBe(0);
    const got = await rows(c.id);
    expect(got.filter((r) => r.status === 'failed' && r.error_class === 'permanent')).toHaveLength(rate);
    expect(got.filter((r) => r.status === 'pending')).toHaveLength(5);
    expect(got.every((r) => r.last_error === null || !r.last_error.includes(WA_NOTE))).toBe(true);
  });

  it('(ג) a regular WhatsApp broadcast and an email broadcast are untouched: WhatsApp at its own 12/min, email delivered', async () => {
    const waList = phones(66100000, 20);
    const instance = newInstance();
    const wa = new MockProvider();
    const email = new MockEmailTransport();
    const waC = await makeWaCampaign(waList, instance);
    const emailC = await createCampaign(pool, {
      channel: 'email', subject: 'נושא', name: `email-rate-${uniq()}`, body: 'שלום',
      audience: { type: 'selection', roles: ['owners'] }, instanceId: null, createdBy: null,
      recipients: [{ contactId, debtorId: null, phoneIntl: '', email: 'rate-test@example.com', subject: 's', payload: 'p' }],
      ratePerMin: 30, dryRun: false,
    });
    made.campaigns.push(emailC.id);
    await startCampaign(pool, emailC.id);
    await pool.query(`delete from public.wa_send_log where bucket = 'email'`);

    await pump(makeWorker(new MockSmsProvider(), wa, email));

    expect(wa.sends).toHaveLength(DEFAULT_WA_RATE_PER_MIN);
    expect((await rows(waC.id)).filter((r) => r.status === 'pending')).toHaveLength(8);
    expect(email.sent.map((m) => m.to)).toEqual(['rate-test@example.com']);
    expect((await getCampaign(pool, emailC.id))!.status).toBe('completed');
  });
});

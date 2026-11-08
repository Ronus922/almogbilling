import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCampaign, startCampaign, getCampaign, retryFailed } from '@/lib/wa-queue/campaigns';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider, type SendInput, type SendResult } from '@/lib/wa-queue/provider';
import { MockSmsProvider } from '@/lib/wa-queue/smsProvider';
import { SMS_RATE_BUCKET, toIsraeliLocal } from '@/lib/wa-queue/sms';
import type { Campaign, Recipient, RecipientInput } from '@/lib/wa-queue/types';

// 08/11/2026 — ONE SMS per recipient, in every scenario. With the opt-in
// WhatsApp fallback on, a recipient whose SMS failed goes to WhatsApp; when that
// WhatsApp send fails with a 5xx or a timeout the queue retries the recipient.
// The retry used to start from the top and run the SMS leg again, so the same
// person could get a second SMS. The retry must run the WhatsApp leg only.
//
// No real message of any kind is sent: MockSmsProvider + a scripted mock
// WhatsApp provider + dry-run campaigns. Each test uses its OWN instance id as
// the WhatsApp bucket, cleaned up by that exact id.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

/** A WhatsApp provider that fails the first `times` sends of a number with the
 *  given status/message (a 5xx, or a timeout = no status), then behaves. */
class FlakyWhatsApp extends MockProvider {
  readonly attempts = new Map<string, number>();
  constructor(private readonly flaky: Record<string, { times: number; status?: number; message: string }>) {
    super();
  }
  async send(input: SendInput): Promise<SendResult> {
    const phone = input.chatId.replace('@c.us', '');
    const n = (this.attempts.get(phone) ?? 0) + 1;
    this.attempts.set(phone, n);
    const f = this.flaky[phone];
    if (f && n <= f.times) return { ok: false, ...(f.status ? { status: f.status } : {}), message: f.message };
    return super.send(input);
  }
  total(): number {
    return [...this.attempts.values()].reduce((a, b) => a + b, 0);
  }
}

const GREEN_503 = { status: 503, message: 'Green API 503 service unavailable' };
const GREEN_TIMEOUT = { message: 'Green API timeout after 60000ms' };

let pool: Pool;
const made = { contacts: [] as string[], campaigns: [] as string[], buckets: [] as string[] };
let contactId: string;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

const phones = (base: number, count: number) => Array.from({ length: count }, (_, i) => `9725${base + i}`);
const recips = (list: string[]): RecipientInput[] =>
  list.map((p) => ({ contactId, debtorId: null, phoneIntl: p, payload: `שלום ${p}` }));

async function makeSmsFallbackCampaign(list: string[]): Promise<{ c: Campaign; instance: string }> {
  const instance = randomUUID();
  made.buckets.push(instance);
  const c = await createCampaign(pool, {
    channel: 'sms', name: `smsretry-${uniq()}`, body: 'שלום',
    audience: { type: 'selection', roles: ['owners'] }, instanceId: instance, createdBy: null,
    recipients: recips(list), ratePerMin: 20, dryRun: true, smsWhatsappFallback: true,
  });
  made.campaigns.push(c.id);
  return { c: await startCampaign(pool, c.id), instance };
}

/** 019 rejects every number in `list` (e.g. 515, unverified sender). */
const failAll019 = (list: string[]) => new MockSmsProvider({
  fail: Object.fromEntries(list.map((p) => [toIsraeliLocal(p) as string, { status: 515, message: '019sms 515: שם השולח לא מאומת' }])),
});

const makeWorker = (sms: MockSmsProvider, wa: MockProvider) => new DeliveryWorker({
  pool, workerId: `smsretry-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
  makeProviderFor: () => wa,
  makeSmsProviderFor: () => sms,
  resolveSmsCreds: () => ({ username: 'u', token: 't', source: 'AlmogTower' }),
});

/** Tick until nothing is due right now. */
async function pump(w: DeliveryWorker): Promise<void> {
  for (let i = 0; i < 200; i++) if (!(await w.tick())) return;
  throw new Error('pump: the worker never went idle');
}

const rows = async (campaignId: string) => (await pool.query<Recipient>(
  `select * from public.wa_campaign_recipients where campaign_id = $1 order by phone_intl`, [campaignId])).rows;

d('wa-queue — a retried SMS-fallback recipient never gets a second SMS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name) values ($1, 'בדיקת SMS חוזר') returning id`,
      [`96${Date.now() % 10_000_000}`]);
    contactId = c.rows[0].id;
    made.contacts.push(contactId);
  });

  beforeEach(async () => {
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

  it('1) WhatsApp fails with a 5xx once, then goes through: ONE SMS, one WhatsApp delivered (two attempts)', async () => {
    const [p] = phones(78000000, 1);
    const sms = failAll019([p]);
    const wa = new FlakyWhatsApp({ [p]: { times: 1, ...GREEN_503 } });
    const { c } = await makeSmsFallbackCampaign([p]);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(1);            // the whole point
    expect(wa.attempts.get(p)).toBe(2);           // the failed try + the one that went through
    const [r] = await rows(c.id);
    expect(r).toMatchObject({ status: 'sent', sent_channel: 'whatsapp', error_class: null });
    expect(r.provider_message_id).toBeTruthy();
    expect(r.last_error).toContain('נשלח בוואטסאפ במקום');
    expect(r.last_error).toContain('515');
    expect(await getCampaign(pool, c.id)).toMatchObject({ status: 'completed', sent_count: 1, failed_count: 0 });
  });

  it('2) WhatsApp times out twice, then goes through: still ONE SMS', async () => {
    const [p] = phones(78100000, 1);
    const sms = failAll019([p]);
    const wa = new FlakyWhatsApp({ [p]: { times: 2, ...GREEN_TIMEOUT } });
    const { c } = await makeSmsFallbackCampaign([p]);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(1);
    expect(wa.attempts.get(p)).toBe(3);
    expect((await rows(c.id))[0]).toMatchObject({ status: 'sent', sent_channel: 'whatsapp' });
  });

  it('3) WhatsApp never recovers: the retries run out, the recipient FAILS with both reasons, and the SMS was still sent exactly once', async () => {
    const [p] = phones(78200000, 1);
    const sms = failAll019([p]);
    const wa = new FlakyWhatsApp({ [p]: { times: 99, ...GREEN_TIMEOUT } });
    const { c } = await makeSmsFallbackCampaign([p]);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(1);
    expect(wa.attempts.get(p)).toBe(5);           // max_attempts
    const [r] = await rows(c.id);
    expect(r.status).toBe('failed');
    expect(r.last_error).toContain('SMS:');
    expect(r.last_error).toContain('515');
    expect(r.last_error).toContain('WhatsApp (גיבוי)');
    expect(r.sent_channel).toBeNull();

    // An explicit operator "retry failed" is a human decision to try again from
    // the top — the ONE path that may send the SMS a second time.
    await retryFailed(pool, c.id);
    expect((await rows(c.id))[0].last_error).toBeNull();
    await pump(makeWorker(sms, wa));
    expect(sms.sends).toHaveLength(2);
  });

  it('4) a batch where every WhatsApp send flakes once: one SMS per person, no more', async () => {
    const list = phones(78300000, 5);
    const sms = failAll019(list);
    const wa = new FlakyWhatsApp(Object.fromEntries(list.map((p) => [p, { times: 1, ...GREEN_503 }])));
    const { c } = await makeSmsFallbackCampaign(list);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(5);
    expect(new Set(sms.sends.map((s) => s.localPhone)).size).toBe(5);
    expect(wa.total()).toBe(10);
    expect((await rows(c.id)).every((r) => r.status === 'sent' && r.sent_channel === 'whatsapp')).toBe(true);
  });

  it('5) unchanged: SMS that goes through is never retried or mirrored to WhatsApp, and a first-try WhatsApp fallback still sends once each', async () => {
    const ok = phones(78400000, 2);
    const bad = phones(78500000, 2);
    const sms = failAll019(bad);
    const wa = new FlakyWhatsApp({});
    const { c } = await makeSmsFallbackCampaign([...ok, ...bad]);
    await pump(makeWorker(sms, wa));

    expect(sms.sends).toHaveLength(4);
    expect(wa.total()).toBe(2);                    // only the two the SMS could not reach
    const got = await rows(c.id);
    expect(got.filter((r) => r.sent_channel === 'sms')).toHaveLength(2);
    expect(got.filter((r) => r.sent_channel === 'whatsapp')).toHaveLength(2);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createCampaign, startCampaign, getCampaign, listRecipients, listCampaigns,
} from '@/lib/wa-queue/campaigns';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider } from '@/lib/wa-queue/provider';
import { MockSmsProvider } from '@/lib/wa-queue/smsProvider';
import { MockEmailTransport } from '@/lib/wa-queue/email';
import { readSmsRatePerMin, SMS_RATE_BUCKET, toIsraeliLocal } from '@/lib/wa-queue/sms';
import type { Campaign, Recipient, RecipientInput } from '@/lib/wa-queue/types';

// The SMS channel of the durable delivery queue (16/10/2026, 019sms), end to
// end against a real database. The one thing genuinely new versus
// whatsapp/email is the per-recipient fallback to WhatsApp when 019 fails or
// the recipient has no valid Israeli mobile — and since 08/11/2026 it is an
// explicit per-campaign OPT-IN (wa_campaigns.sms_whatsapp_fallback, default
// false): a campaign without the flag must never produce a WhatsApp send, in
// any path. No real message of any kind is sent: MockSmsProvider + MockProvider.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod,
// on a schema that already carries migration 20261016163824 (dbmate up).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

/** Every row this suite creates, removed by id at the end (iron rule 12). */
const made = { contacts: [] as string[], campaigns: [] as string[] };
let contactId: string;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;

async function drain(worker: DeliveryWorker, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const did = await worker.tick();
    const q = await pool.query<{ n: number }>(
      `select count(*)::int n from public.wa_campaign_recipients
        where campaign_id = any($1::uuid[]) and status in ('pending','processing')`,
      [made.campaigns]);
    if (q.rows[0].n === 0) return;
    if (!did) await new Promise((r) => setTimeout(r, 10));
  }
}

async function rows(campaignId: string): Promise<Recipient[]> {
  const r = await pool.query<Recipient>(
    `select * from public.wa_campaign_recipients where campaign_id = $1 order by phone_intl`,
    [campaignId]);
  return r.rows;
}

function smsRecips(...phones: string[]): RecipientInput[] {
  return phones.map((p) => ({ contactId, debtorId: null, phoneIntl: p, payload: `שלום ${p}` }));
}

/** dryRun:true so the WhatsApp-fallback leg never needs a real
 *  whatsapp_instances row — mirrors how the whatsapp fixtures in
 *  wa-queue-email.test.ts resolve creds. */
async function makeSmsCampaign(recipients: RecipientInput[], opts: { fallback?: boolean } = {}): Promise<Campaign> {
  const c = await createCampaign(pool, {
    channel: 'sms', name: `sms-${uniq()}`, body: 'שלום {{name}}',
    audience: { type: 'selection', roles: ['owners'] }, instanceId: null, createdBy: null,
    recipients, ratePerMin: 20, dryRun: true,
    // Explicit everywhere: the default (no flag) is the safe one under test.
    smsWhatsappFallback: opts.fallback ?? false,
  });
  made.campaigns.push(c.id);
  return startCampaign(pool, c.id);
}

function worker(opts: { smsProvider?: MockSmsProvider; waProvider?: MockProvider } = {}) {
  return new DeliveryWorker({
    pool, workerId: `sms-test-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
    makeProviderFor: () => opts.waProvider ?? new MockProvider(),
    makeSmsProviderFor: () => opts.smsProvider ?? new MockSmsProvider(),
    resolveSmsCreds: () => ({ username: 'yeadim70', token: 'test-token', source: 'AlmogTower' }),
  });
}

d('wa-queue — sms channel (019, WhatsApp fallback)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name) values ($1, 'בדיקת SMS') returning id`,
      [`98${Date.now() % 10_000_000}`]);
    contactId = c.rows[0].id;
    made.contacts.push(contactId);
    // Shared rate window — must not be throttled by an earlier run (see the
    // same note in wa-queue-email.test.ts for the email bucket).
    await pool.query(`delete from public.wa_send_log where bucket = $1`, [SMS_RATE_BUCKET]);
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.campaigns.length) await pool.query(`delete from public.wa_campaigns where id = any($1::uuid[])`, [made.campaigns]);
    if (made.contacts.length) await pool.query(`delete from public.contacts where id = any($1::uuid[])`, [made.contacts]);
    await pool.end();
  });

  it('toIsraeliLocal: an Israeli mobile → 019\'s local shape; anything else → null (fallback-eligible)', () => {
    expect(toIsraeliLocal('972541234567')).toBe('0541234567');
    expect(toIsraeliLocal('14155552671')).toBeNull();   // foreign
    expect(toIsraeliLocal('97237654321')).toBeNull();   // IL landline (02)
  });

  it('a successful 019 send: sent_channel=sms, provider_message_id from 019, no WhatsApp attempt', async () => {
    const sms = new MockSmsProvider();
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('972500000201'));
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    expect(sms.sends).toEqual([{ localPhone: '0500000201', message: 'שלום 972500000201' }]);
    expect(wa.sends).toEqual([]);
    const [r] = await rows(c.id);
    expect(r).toMatchObject({ status: 'sent', sent_channel: 'sms', last_error: null });
    expect(r.provider_message_id).toMatch(/^mock-sms-/);
    expect((await getCampaign(pool, c.id))).toMatchObject({ status: 'completed', sent_count: 1 });
  });

  it('WITH the flag: 019 rejects the send (e.g. unverified sender) → falls back to WhatsApp, sent_channel=whatsapp, reason kept in last_error', async () => {
    const sms = new MockSmsProvider({ fail: { '0500000202': { status: 515, message: '019sms (515): שם השולח לא מאומת' } } });
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('972500000202'), { fallback: true });
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    expect(wa.sends.map((s) => s.chatId)).toEqual(['972500000202@c.us']);
    const [r] = await rows(c.id);
    expect(r.status).toBe('sent');
    expect(r.sent_channel).toBe('whatsapp');
    expect(r.last_error).toContain('515');
    expect(r.last_error).toContain('נשלח בוואטסאפ במקום');
  });

  it('WITH the flag, no valid Israeli mobile: 019 is never attempted, straight to WhatsApp', async () => {
    const sms = new MockSmsProvider();
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('14155552671'), { fallback: true }); // foreign — WhatsApp-eligible, not 019-eligible
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    expect(sms.sends).toEqual([]);
    expect(wa.sends.map((s) => s.chatId)).toEqual(['14155552671@c.us']);
    const [r] = await rows(c.id);
    expect(r).toMatchObject({ status: 'sent', sent_channel: 'whatsapp' });
    expect(r.last_error).toContain('אין מספר נייד ישראלי תקין');
  });

  it('WITH the flag, both 019 and the WhatsApp fallback fail: the recipient fails (not silently dropped), both reasons kept', async () => {
    const sms = new MockSmsProvider({ fail: { '0500000204': { message: '019sms לא הגיב: timeout' } } });
    const wa = new MockProvider({ fail: { '972500000204': { message: 'green api 500', status: 500 } } });
    const c = await makeSmsCampaign(smsRecips('972500000204'), { fallback: true });
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    const [r] = await rows(c.id);
    expect(r.status).toBe('failed');
    expect(r.last_error).toContain('SMS:');
    expect(r.last_error).toContain('timeout');
    expect(r.last_error).toContain('WhatsApp (גיבוי)');
    expect(r.sent_channel).toBeNull();
    expect((await getCampaign(pool, c.id))).toMatchObject({ status: 'completed_with_errors', failed_count: 1 });
  });

  // ── 08/11/2026 — the fallback is opt-in: WITHOUT the flag nothing goes out over WhatsApp ──

  it('NO flag, 019 rejects (515 unverified sender): ZERO WhatsApp sends, the recipient FAILS with 019\'s real code and reason, one SMS attempt only', async () => {
    const sms = new MockSmsProvider({ fail: { '0500000301': { status: 515, message: '019sms 515: שם השולח (SMS_SENDER) לא מאומת בחשבון 019' } } });
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('972500000301')); // no flag
    expect(c.sms_whatsapp_fallback).toBe(false);
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    expect(wa.sends).toEqual([]);                       // the hard rule
    expect(sms.sends).toHaveLength(1);                  // never a second SMS attempt
    const [r] = await rows(c.id);
    expect(r.status).toBe('failed');
    expect(r.sent_channel).toBeNull();
    expect(r.error_class).toBe('permanent');
    expect(r.last_error).toContain('515');
    expect(r.last_error).toContain('שם השולח');
    expect(r.last_error).not.toContain('וואטסאפ');
    expect(await getCampaign(pool, c.id)).toMatchObject({ status: 'completed_with_errors', failed_count: 1, sent_count: 0 });
  });

  it('NO flag, recipient without a valid Israeli mobile: neither 019 nor WhatsApp is touched, the recipient FAILS (invalid_phone)', async () => {
    const sms = new MockSmsProvider();
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('14155552671', '97237654321')); // foreign + IL landline
    await drain(worker({ smsProvider: sms, waProvider: wa }));

    expect(sms.sends).toEqual([]);
    expect(wa.sends).toEqual([]);
    const got = await rows(c.id);
    expect(got).toHaveLength(2);
    for (const r of got) {
      expect(r.status).toBe('failed');
      expect(r.error_class).toBe('invalid_phone');
      expect(r.sent_channel).toBeNull();
      expect(r.last_error).toContain('אין מספר נייד ישראלי תקין');
    }
  });

  it('NO flag: the worker does not even build a WhatsApp provider for the campaign (no creds resolved)', async () => {
    let providerRequests = 0;
    const sms = new MockSmsProvider({ fail: { '0500000303': { status: 515, message: '019sms 515: x' } } });
    const c = await makeSmsCampaign(smsRecips('972500000303'));
    await drain(new DeliveryWorker({
      pool, workerId: `sms-nowa-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
      makeProviderFor: () => { providerRequests++; return new MockProvider(); },
      makeSmsProviderFor: () => sms,
      resolveSmsCreds: () => ({ username: 'u', token: 't', source: 'AlmogTower' }),
    }));
    expect(providerRequests).toBe(0);
    expect((await rows(c.id))[0].status).toBe('failed');
  });

  it('NO flag: a successful 019 send is unchanged (sent_channel=sms) and a mixed campaign only fails the failing recipient', async () => {
    const sms = new MockSmsProvider({ fail: { '0500000305': { status: 515, message: '019sms 515: x' } } });
    const wa = new MockProvider();
    const c = await makeSmsCampaign(smsRecips('972500000304', '972500000305'));
    await drain(worker({ smsProvider: sms, waProvider: wa }));
    const [ok, bad] = await rows(c.id);
    expect(ok).toMatchObject({ status: 'sent', sent_channel: 'sms' });
    expect(bad).toMatchObject({ status: 'failed', sent_channel: null });
    expect(wa.sends).toEqual([]);
  });

  it('the flag defaults to false on a campaign created without it, and the schema refuses it on any channel but sms', async () => {
    const c = await createCampaign(pool, {
      channel: 'sms', name: `sms-default-${uniq()}`, body: 'x', audience: { type: 'selection', roles: ['owners'] },
      instanceId: null, createdBy: null, recipients: smsRecips('972500000306'), ratePerMin: 20, dryRun: true,
    });
    made.campaigns.push(c.id);
    expect(c.sms_whatsapp_fallback).toBe(false);

    await expect(createCampaign(pool, {
      channel: 'whatsapp', name: `wa-flag-${uniq()}`, body: 'x', audience: { type: 'selection', roles: ['owners'] },
      instanceId: null, createdBy: null, recipients: smsRecips('972500000307'), ratePerMin: 12, dryRun: true,
      smsWhatsappFallback: true,
    })).rejects.toThrow(/wa_campaigns_sms_whatsapp_fallback_check/);
    await expect(createCampaign(pool, {
      channel: 'email', subject: 's', name: `email-flag-${uniq()}`, body: 'x', audience: { type: 'selection', roles: ['owners'] },
      instanceId: null, createdBy: null, recipients: [{ contactId, debtorId: null, phoneIntl: '', email: 'flag@example.com', subject: 's', payload: 'p' }],
      ratePerMin: 30, dryRun: true, smsWhatsappFallback: true,
    })).rejects.toThrow(/wa_campaigns_sms_whatsapp_fallback_check/);
  });

  it('WhatsApp and email broadcasts are unaffected: a plain WhatsApp campaign still sends over WhatsApp, with no SMS provider involved', async () => {
    const sms = new MockSmsProvider();
    const wa = new MockProvider();
    const c = await createCampaign(pool, {
      channel: 'whatsapp', name: `wa-plain-${uniq()}`, body: 'x', audience: { type: 'selection', roles: ['owners'] },
      instanceId: null, createdBy: null, recipients: smsRecips('972500000308'), ratePerMin: 120, dryRun: true,
    });
    made.campaigns.push(c.id);
    await startCampaign(pool, c.id);
    await drain(worker({ smsProvider: sms, waProvider: wa }));
    expect(wa.sends.map((s) => s.chatId)).toEqual(['972500000308@c.us']);
    expect(sms.sends).toEqual([]);
    expect((await getCampaign(pool, c.id))).toMatchObject({ status: 'completed', channel: 'whatsapp', sms_whatsapp_fallback: false });
  });

  it('routes by channel: sms uses the 019 + fallback providers, never the email transport; a parallel email campaign is unaffected', async () => {
    const sms = new MockSmsProvider();
    const wa = new MockProvider();
    const transport = new MockEmailTransport();
    const smsC = await makeSmsCampaign(smsRecips('972500000205'));
    const emailC = await createCampaign(pool, {
      channel: 'email', subject: 'נושא', name: `email-${uniq()}`, body: 'שלום',
      audience: { type: 'selection', roles: ['owners'] }, instanceId: null, createdBy: null,
      recipients: [{ contactId, debtorId: null, phoneIntl: '', email: 'route-sms-test@example.com', subject: 's', payload: 'p' }],
      ratePerMin: 30, dryRun: false,
    });
    made.campaigns.push(emailC.id);
    await startCampaign(pool, emailC.id);

    await drain(new DeliveryWorker({
      pool, workerId: `sms-route-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
      makeProviderFor: () => wa, makeSmsProviderFor: () => sms,
      resolveSmsCreds: () => ({ username: 'u', token: 't', source: 'AlmogTower' }),
      makeEmailTransportFor: () => transport,
    }));

    expect(sms.sends.map((s) => s.localPhone)).toEqual(['0500000205']);
    expect(transport.sent.map((m) => m.to)).toEqual(['route-sms-test@example.com']);
    expect(wa.sends).toEqual([]); // the sms recipient succeeded — no fallback needed
    expect((await getCampaign(pool, smsC.id))!.status).toBe('completed');
    expect((await getCampaign(pool, emailC.id))!.status).toBe('completed');
  });

  it('the delivery log surfaces sent_channel; the history filters sms separately from whatsapp/email', async () => {
    const c = await makeSmsCampaign(smsRecips('972500000206'));
    await drain(worker());
    const log = await listRecipients(pool, c.id);
    expect(log.rows[0].sent_channel).toBe('sms');

    const smsOnly = await listCampaigns(pool, { channel: 'sms', limit: 100 });
    expect(smsOnly.rows.every((x) => x.channel === 'sms')).toBe(true);
    expect(smsOnly.rows.some((x) => x.id === c.id)).toBe(true);
    const was = await listCampaigns(pool, { channel: 'whatsapp', limit: 100 });
    expect(was.rows.some((x) => x.id === c.id)).toBe(false);
  });

  it('sms pace: app_settings sms_rate_per_min (our own default 20), out-of-range values fall back', async () => {
    const before = await pool.query<{ value: unknown }>(`select value from public.app_settings where key = 'sms_rate_per_min'`);
    try {
      await pool.query(`insert into public.app_settings (key, value) values ('sms_rate_per_min', '15'::jsonb)
                         on conflict (key) do update set value = excluded.value`);
      expect(await readSmsRatePerMin(pool)).toBe(15);
      await pool.query(`update public.app_settings set value = '0'::jsonb where key = 'sms_rate_per_min'`);
      expect(await readSmsRatePerMin(pool)).toBe(20);
    } finally {
      if (before.rows[0]) {
        await pool.query(`update public.app_settings set value = $1::jsonb where key = 'sms_rate_per_min'`, [JSON.stringify(before.rows[0].value)]);
      } else {
        await pool.query(`delete from public.app_settings where key = 'sms_rate_per_min'`);
      }
    }
  });
});

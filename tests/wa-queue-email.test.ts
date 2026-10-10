import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  createCampaign, startCampaign, retryFailed, getCampaign, listRecipients, listCampaigns,
} from '@/lib/wa-queue/campaigns';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider } from '@/lib/wa-queue/provider';
import {
  MockEmailTransport, readEmailRatePerMin, EMAIL_RATE_BUCKET, EMAIL_AUTH_FAILED_MESSAGE,
} from '@/lib/wa-queue/email';
import type { Campaign, Recipient, RecipientInput } from '@/lib/wa-queue/types';

// The EMAIL channel of the durable delivery queue (09/10/2026), end to end
// against a real database: the worker routes each campaign by its channel —
// WhatsApp exactly as before, email through the injected transport — with the
// same leases, statuses, counters and retry policy. No real message of either
// kind is sent: MockProvider + MockEmailTransport.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod,
// on a schema that already carries migration 20261009210844 (dbmate up).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never
// as passed — scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

/** Every row this suite creates, removed by id at the end (iron rule 12). */
const made = { contacts: [] as string[], campaigns: [] as string[], attachments: [] as string[] };
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
    `select * from public.wa_campaign_recipients where campaign_id = $1 order by email nulls first, phone_intl`,
    [campaignId]);
  return r.rows;
}

function emailRecips(...addresses: string[]): RecipientInput[] {
  return addresses.map((a) => ({
    contactId, debtorId: null, phoneIntl: '', email: a, subject: `נושא ל-${a}`, payload: `שלום ${a}`,
  }));
}

async function makeEmailCampaign(recipients: RecipientInput[], extra: { attachmentIds?: string[]; createdBy?: string | null } = {}): Promise<Campaign> {
  const c = await createCampaign(pool, {
    channel: 'email', subject: 'נושא {{name}}', name: `email-${uniq()}`, body: 'שלום {{name}}',
    audience: { type: 'selection', roles: ['owners'] }, instanceId: null, createdBy: extra.createdBy ?? null,
    recipients, ratePerMin: 30, dryRun: false, attachmentIds: extra.attachmentIds,
  });
  made.campaigns.push(c.id);
  return startCampaign(pool, c.id);
}

function worker(opts: { provider?: MockProvider; transport?: MockEmailTransport; onAuth?: () => Promise<void>; reader?: (a: { object_key: string }) => Promise<Buffer> } = {}) {
  return new DeliveryWorker({
    pool, workerId: `email-test-${uniq()}`, idlePollMs: 5, backoffBaseSec: 0,
    makeProviderFor: () => opts.provider ?? new MockProvider(),
    makeEmailTransportFor: () => opts.transport ?? new MockEmailTransport(),
    onSmtpAuthFailure: opts.onAuth ?? (async () => {}),
    readAttachment: opts.reader,
  });
}

d('wa-queue — email channel', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 6 });
    pool.on('error', () => {});
    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name) values ($1, 'בדיקת מייל') returning id`,
      [`99${Date.now() % 10_000_000}`]);
    contactId = c.rows[0].id;
    made.contacts.push(contactId);
    // The shared rate window must not be throttled by an earlier run. The email
    // bucket counts the trailing 60s against email_rate_per_min (default 30), so
    // a run within a minute of the last one was paced and its drains ran dry.
    // Until 10/10/2026 this deleted only rows older than 10 minutes — already
    // outside the window. On the throwaway database the bucket holds nothing but
    // this suite's earlier runs.
    await pool.query(`delete from public.wa_send_log where bucket = $1`, [EMAIL_RATE_BUCKET]);
  });

  afterAll(async () => {
    if (!pool) return;
    if (made.attachments.length) await pool.query(`delete from public.wa_campaign_attachments where id = any($1::uuid[])`, [made.attachments]);
    if (made.campaigns.length) await pool.query(`delete from public.wa_campaigns where id = any($1::uuid[])`, [made.campaigns]);
    if (made.contacts.length) await pool.query(`delete from public.contacts where id = any($1::uuid[])`, [made.contacts]);
    await pool.end();
  });

  it('an email recipient row: address + subject snapshot, empty WhatsApp columns, per-address idempotency', async () => {
    const c = await makeEmailCampaign(emailRecips('a1@example.com', 'a1@example.com', 'a2@example.com'));
    expect(c.channel).toBe('email');
    expect(c.subject).toBe('נושא {{name}}');
    const r = await rows(c.id);
    expect(r).toHaveLength(2); // the duplicate address collapsed on idempotency_key
    expect(r.map((x) => x.email)).toEqual(['a1@example.com', 'a2@example.com']);
    expect(r.every((x) => x.phone_intl === '' && x.chat_id === '')).toBe(true);
    const keys = await pool.query<{ idempotency_key: string }>(
      `select idempotency_key from public.wa_campaign_recipients where campaign_id = $1 order by email`, [c.id]);
    expect(keys.rows.map((k) => k.idempotency_key)).toEqual([`${c.id}:email:a1@example.com`, `${c.id}:email:a2@example.com`]);
    await drain(worker());
  });

  it('routes by channel: email → the email transport, WhatsApp → the provider; never crossed', async () => {
    const provider = new MockProvider();
    const transport = new MockEmailTransport();
    const wa = await createCampaign(pool, {
      name: `wa-${uniq()}`, body: 'b', audience: {}, instanceId: null, createdBy: null, ratePerMin: 120, dryRun: true,
      recipients: [{ contactId, debtorId: null, phoneIntl: '972500000101', payload: 'וואטסאפ' }],
    });
    made.campaigns.push(wa.id);
    expect(wa.channel).toBe('whatsapp');
    await startCampaign(pool, wa.id);
    const em = await makeEmailCampaign(emailRecips('route@example.com'));

    await drain(worker({ provider, transport }));

    expect(provider.sends.map((s) => s.chatId)).toEqual(['972500000101@c.us']);
    expect(transport.sent.map((m) => m.to)).toEqual(['route@example.com']);
    expect((await getCampaign(pool, wa.id))!.status).toBe('completed');
    expect((await getCampaign(pool, em.id))!.status).toBe('completed');
  });

  it('one email per recipient: a single To, its own subject, HTML + text, sent status + message id', async () => {
    const transport = new MockEmailTransport();
    const c = await makeEmailCampaign(emailRecips('one@example.com', 'two@example.com'));
    await drain(worker({ transport }));

    expect(transport.sent).toHaveLength(2);
    for (const m of transport.sent) {
      expect(m.to).not.toContain(',');
      expect(m.subject).toBe(`נושא ל-${m.to}`);
      expect(m.text).toContain(`שלום ${m.to}`);
      expect(m.html).toContain('dir="rtl"');
    }
    const r = await rows(c.id);
    expect(r.every((x) => x.status === 'sent' && x.provider_message_id?.startsWith('mock-email-'))).toBe(true);
    const camp = (await getCampaign(pool, c.id))!;
    expect(camp).toMatchObject({ status: 'completed', sent_count: 2, failed_count: 0, total_count: 2 });
    const log = await pool.query<{ n: number }>(
      `select count(*)::int n from public.wa_send_log where bucket = $1 and sent_at > now() - interval '60 seconds'`, [EMAIL_RATE_BUCKET]);
    expect(log.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('the campaign files ride as real attachments, read server-side — never uploaded to Green API', async () => {
    const provider = new MockProvider();
    const transport = new MockEmailTransport();
    const att = await pool.query<{ id: string }>(
      `insert into public.wa_campaign_attachments (bucket, object_key, original_name, mime_type, size_bytes)
       values ('whatsapp-attachments', $1, 'מסמך.pdf', 'application/pdf', 4) returning id`,
      [`${uniq()}.pdf`]);
    made.attachments.push(att.rows[0].id);
    const c = await makeEmailCampaign(emailRecips('files@example.com'));
    await pool.query(`update public.wa_campaign_attachments set campaign_id = $1, sort_order = 0 where id = $2`, [c.id, att.rows[0].id]);

    const read: string[] = [];
    await drain(worker({ provider, transport, reader: async (a) => { read.push(a.object_key); return Buffer.from('%PDF'); } }));

    expect(provider.uploads).toEqual([]);
    expect(read).toHaveLength(1);
    const [m] = transport.sent;
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: 'מסמך.pdf', contentType: 'application/pdf' });
    expect(m.attachments[0].content.toString()).toBe('%PDF');
    expect((await rows(c.id))[0].attachments_sent).toBe(1);
  });

  it('SMTP auth rejected: the alert is raised, this and every pending recipient fail as auth; "retry failed" re-queues them', async () => {
    let alerts = 0;
    // A 535 is a rejected login, so it answers whichever address goes first. The
    // three rows are claimed in one batch and the claim's RETURNING has no order
    // (until 10/10/2026 only auth1 was rejected, and the run failed whenever
    // another row came back first). One alert and nothing sent prove the breaker
    // stopped the two rows still waiting in the batch.
    const rejected = { message: 'smtp: 535', authFailure: true };
    const bad = new MockEmailTransport({ fail: { 'auth1@example.com': rejected, 'auth2@example.com': rejected, 'auth3@example.com': rejected } });
    const c = await makeEmailCampaign(emailRecips('auth1@example.com', 'auth2@example.com', 'auth3@example.com'));
    await drain(worker({ transport: bad, onAuth: async () => { alerts++; } }));

    expect(alerts).toBe(1);
    expect(bad.sent).toHaveLength(0);
    const r = await rows(c.id);
    expect(r.every((x) => x.status === 'failed' && x.error_class === 'auth' && x.last_error === EMAIL_AUTH_FAILED_MESSAGE)).toBe(true);
    expect((await getCampaign(pool, c.id))!.status).toBe('completed_with_errors');

    // The App Password is fixed → the operator's retry sends all three.
    const good = new MockEmailTransport();
    const { requeued } = await retryFailed(pool, c.id);
    expect(requeued).toBe(3);
    await drain(worker({ transport: good }));
    expect(good.sent.map((m) => m.to).sort()).toEqual(['auth1@example.com', 'auth2@example.com', 'auth3@example.com']);
    expect((await getCampaign(pool, c.id))!.status).toBe('completed');
  });

  it('a transient SMTP failure is retried with backoff; a permanent one fails the recipient only', async () => {
    let calls = 0;
    const flaky = new MockEmailTransport();
    const original = flaky.send.bind(flaky);
    flaky.send = async (m) => {
      if (m.to === 'flaky@example.com' && calls++ === 0) return { ok: false, message: 'smtp: 421 try later', authFailure: false, transient: true };
      if (m.to === 'gone@example.com') return { ok: false, message: 'smtp: 550 no such user', authFailure: false, transient: false };
      return original(m);
    };
    const c = await makeEmailCampaign(emailRecips('flaky@example.com', 'gone@example.com'));
    await drain(worker({ transport: flaky }));

    const r = await rows(c.id);
    const flakyRow = r.find((x) => x.email === 'flaky@example.com')!;
    const goneRow = r.find((x) => x.email === 'gone@example.com')!;
    expect(flakyRow).toMatchObject({ status: 'sent', attempt_count: 2 });
    expect(goneRow).toMatchObject({ status: 'failed', error_class: 'permanent', attempt_count: 1 });
    expect(goneRow.last_error).toContain('550');
  });

  it('a recipient row without an address is failed, never sent', async () => {
    const transport = new MockEmailTransport();
    const c = await makeEmailCampaign([{ contactId, debtorId: null, phoneIntl: '', email: 'ok@example.com', subject: 's', payload: 'p' }]);
    // A row that lost its address (cannot come from the route) — the worker's own guard.
    await pool.query(
      `insert into public.wa_campaign_recipients (campaign_id, contact_id, phone_intl, chat_id, payload, idempotency_key, subject)
       values ($1, $2, '', '', 'p', $3, 's')`,
      [c.id, contactId, `${c.id}:email:none`]);
    await pool.query(`select public.reconcile_wa_campaign($1)`, [c.id]);
    await drain(worker({ transport }));

    expect(transport.sent.map((m) => m.to)).toEqual(['ok@example.com']);
    const noAddr = (await rows(c.id)).find((x) => x.email === null)!;
    expect(noAddr).toMatchObject({ status: 'failed', last_error: 'אין כתובת אימייל לנמען' });
  });

  it('the delivery log masks the address; the history filters by channel', async () => {
    const c = await makeEmailCampaign(emailRecips('ronen.test@example.com'));
    await drain(worker());
    const log = await listRecipients(pool, c.id);
    expect(log.rows[0]).toMatchObject({ email_masked: 'ro•••@example.com', phone_masked: '•••' });

    const emails = await listCampaigns(pool, { channel: 'email', limit: 100 });
    expect(emails.rows.every((x) => x.channel === 'email')).toBe(true);
    expect(emails.rows.some((x) => x.id === c.id)).toBe(true);
    const was = await listCampaigns(pool, { channel: 'whatsapp', limit: 100 });
    expect(was.rows.some((x) => x.id === c.id)).toBe(false);
  });

  it('the delivery log names who it went to: the snapshot on both channels, "" → no name, NULL (an older row) → the primary owner', async () => {
    const em = await makeEmailCampaign([
      { contactId, debtorId: null, phoneIntl: '', email: 'aa.name@example.com', subject: 's', payload: 'p', recipientName: 'בעלים נוסף' },
      { contactId, debtorId: null, phoneIntl: '', email: 'bb.name@example.com', subject: 's', payload: 'p', recipientName: '' },
      { contactId, debtorId: null, phoneIntl: '', email: 'cc.name@example.com', subject: 's', payload: 'p' },
    ]);
    const stored = await pool.query<{ email: string; recipient_name: string | null }>(
      `select email, recipient_name from public.wa_campaign_recipients where campaign_id = $1 order by email`, [em.id]);
    expect(stored.rows).toEqual([
      { email: 'aa.name@example.com', recipient_name: 'בעלים נוסף' },
      { email: 'bb.name@example.com', recipient_name: '' },
      { email: 'cc.name@example.com', recipient_name: null },
    ]);
    // The contact's primary owner is 'בדיקת מייל' — shown only for the NULL row.
    const log = await listRecipients(pool, em.id);
    expect(Object.fromEntries(log.rows.map((r) => [r.email_masked, r.debtor_name]))).toEqual({
      'aa•••@example.com': 'בעלים נוסף',
      'bb•••@example.com': null,
      'cc•••@example.com': 'בדיקת מייל',
    });

    const wa = await createCampaign(pool, {
      name: `wa-name-${uniq()}`, body: 'b', audience: {}, instanceId: null, createdBy: null, ratePerMin: 120, dryRun: true,
      recipients: [{ contactId, debtorId: null, phoneIntl: '972500000177', payload: 'p', recipientName: 'שוכר הדירה' }],
    });
    made.campaigns.push(wa.id);
    expect((await listRecipients(pool, wa.id)).rows.map((r) => r.debtor_name)).toEqual(['שוכר הדירה']);
    await drain(worker());
  });

  it('email pace: app_settings email_rate_per_min (default 30), out-of-range values fall back', async () => {
    const before = await pool.query<{ value: unknown }>(`select value from public.app_settings where key = 'email_rate_per_min'`);
    try {
      await pool.query(`insert into public.app_settings (key, value) values ('email_rate_per_min', '45'::jsonb)
                         on conflict (key) do update set value = excluded.value`);
      expect(await readEmailRatePerMin(pool)).toBe(45);
      await pool.query(`update public.app_settings set value = '0'::jsonb where key = 'email_rate_per_min'`);
      expect(await readEmailRatePerMin(pool)).toBe(30);
    } finally {
      if (before.rows[0]) {
        await pool.query(`update public.app_settings set value = $1::jsonb where key = 'email_rate_per_min'`, [JSON.stringify(before.rows[0].value)]);
      } else {
        await pool.query(`delete from public.app_settings where key = 'email_rate_per_min'`);
      }
    }
    expect(await readEmailRatePerMin(pool)).toBe(before.rows[0] ? Number(before.rows[0].value) : 30);
  });

  it('the schema refuses an email broadcast without a subject', async () => {
    await expect(pool.query(
      `insert into public.wa_campaigns (name, body, channel) values ('x', 'y', 'email')`,
    )).rejects.toThrow(/wa_campaigns_email_subject_check/);
    await expect(pool.query(
      `insert into public.wa_campaigns (name, body, channel, subject) values ('x', 'y', 'sms', 's')`,
    )).rejects.toThrow(/wa_campaigns_channel_check/);
  });
});

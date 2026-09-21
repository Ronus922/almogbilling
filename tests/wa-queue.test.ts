import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { hasPermission } from '@/lib/permissions/check';
import { DEFAULT_VIEWER, DEFAULT_MANAGER } from '@/lib/permissions/constants';
import {
  createCampaign, startCampaign, pauseCampaign, resumeCampaign, cancelCampaign,
  retryFailed, getCampaign, listRecipients, CampaignConflictError,
} from '@/lib/wa-queue/campaigns';
import { claimBatch, recoverLeases, reconcileStale } from '@/lib/wa-queue/engine';
import { DeliveryWorker } from '@/lib/wa-queue/worker';
import { MockProvider } from '@/lib/wa-queue/provider';
import { backoffSeconds, classifyError } from '@/lib/wa-queue/errors';
import type { RecipientInput, Recipient } from '@/lib/wa-queue/types';

// Integration suite for the durable WhatsApp delivery engine. Runs ONLY when a
// throwaway test DB is wired (WA_TEST_DATABASE_URL) — never the prod DB — and uses
// the mock provider so NO real WhatsApp message is ever sent.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;
/** One throwaway contacts row (contact_id is a required FK on every recipient
 *  now) shared by every fixture in this file — this suite only exercises the
 *  delivery engine, not recipient identity, so a single fixture is enough. */
let fixtureContactId: string;
/** A second apartment, used only by the wa_campaign_recipient_apartments
 *  (PR ב') tests below — a consolidated recipient needs 2+ distinct apartments. */
let fixtureContactId2: string;
/** A supplier, for the multi-select audience (Section 3) supplier-recipient test. */
let fixtureSupplierId: string;

function recips(...phones: string[]): RecipientInput[] {
  return phones.map((p) => ({ contactId: fixtureContactId, debtorId: null, phoneIntl: p, payload: `hi ${p}` }));
}

// Raw recipient rows (table truth) — for asserting internal fields the public
// log view (listRecipients) intentionally hides (idempotency_key, provider ids).
async function rawRecipients(campaignId: string, status?: string): Promise<Recipient[]> {
  const params: unknown[] = [campaignId];
  let where = 'campaign_id=$1';
  if (status) { params.push(status); where += ' and status=$2'; }
  const r = await pool.query<Recipient>(
    `select * from public.wa_campaign_recipients where ${where} order by created_at`, params);
  return r.rows;
}

async function drain(worker: DeliveryWorker, maxTicks = 300): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const did = await worker.tick();
    const q = await pool.query<{ n: string }>(
      `select count(*)::int n from public.wa_campaign_recipients where status in ('pending','processing')`);
    if (Number(q.rows[0].n) === 0) return;
    if (!did) await new Promise((r) => setTimeout(r, 10));
  }
}

function mockWorker(provider: MockProvider, workerId = 'w1', leaseSec = 60) {
  return new DeliveryWorker({ pool, workerId, leaseSec, makeProviderFor: () => provider, idlePollMs: 5, backoffBaseSec: 0 });
}

const base = { name: 'c', body: 'b', audience: {}, instanceId: null, createdBy: null, dryRun: true, ratePerMin: 120 } as const;

d('wa-queue durable delivery engine', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 8 });
    // Swallow idle-backend termination (Supavisor {:shutdown, :db_termination}) —
    // expected teardown noise; mirrors src/lib/db.ts's pool 'error' handler.
    pool.on('error', () => {});
    const sql = readFileSync(fileURLToPath(new URL('../supabase/migrations/059_whatsapp_delivery_queue.sql', import.meta.url)), 'utf8');
    await pool.query(sql);
    // Broadcast attachments (dbmate migration, after the frozen 059): apply its
    // `-- migrate:up` section — idempotent on a DB that already has it.
    const att = readFileSync(fileURLToPath(new URL('../db/migrations/20260914170628_wa_campaign_attachments.sql', import.meta.url)), 'utf8');
    const up = att.split('-- migrate:down')[0].replace('-- migrate:up', '');
    const has = await pool.query(`select to_regclass('public.wa_campaign_attachments') as t`);
    if (!has.rows[0]?.t) await pool.query(up);
    // wa_campaign_recipient_apartments + supplier_id + nullable contact_id
    // (dbmate migration, after 20260914170628 above) — same idempotent apply.
    const apts = readFileSync(fileURLToPath(new URL('../db/migrations/20260921090433_wa_campaign_recipient_apartments_and_suppliers.sql', import.meta.url)), 'utf8');
    const aptsUp = apts.split('-- migrate:down')[0].replace('-- migrate:up', '');
    const hasApts = await pool.query(`select to_regclass('public.wa_campaign_recipient_apartments') as t`);
    if (!hasApts.rows[0]?.t) await pool.query(aptsUp);

    const c = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name)
       values ($1, 'wa-queue test fixture') returning id`,
      [`wa-queue-test-${Date.now()}`],
    );
    fixtureContactId = c.rows[0]!.id;
    const c2 = await pool.query<{ id: string }>(
      `insert into public.contacts (apartment_number, owner_name)
       values ($1, 'wa-queue test fixture 2') returning id`,
      [`wa-queue-test-2-${Date.now()}`],
    );
    fixtureContactId2 = c2.rows[0]!.id;
    const s = await pool.query<{ id: string }>(
      `insert into public.suppliers (display_name) values ('wa-queue test supplier') returning id`,
    );
    fixtureSupplierId = s.rows[0]!.id;
  });
  afterAll(async () => {
    await pool.query('delete from public.contacts where id = $1', [fixtureContactId]);
    await pool.query('delete from public.contacts where id = $1', [fixtureContactId2]);
    await pool.query('delete from public.suppliers where id = $1', [fixtureSupplierId]);
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query('truncate public.wa_campaign_attachments, public.wa_campaign_recipient_apartments, public.wa_campaign_recipients, public.wa_campaigns, public.wa_send_log, public.wa_worker_heartbeat');
  });

  it('creates + enqueues with unique idempotency keys and correct counts', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    expect(c.status).toBe('queued');
    expect(c.total_count).toBe(2);
    expect(c.pending_count).toBe(2);
    const keys = (await rawRecipients(c.id)).map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('dedups duplicate recipients by idempotency key', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250001') });
    expect(c.total_count).toBe(1);
  });

  // Section 3: a supplier recipient (multi-select audience) has NO contact_id
  // at all — the schema's CHECK constraint (contact_id is not null OR
  // supplier_id is not null) is what actually enforces this is never both-null.
  it('writes a supplier recipient with contact_id null and supplier_id set; the recipient log shows the supplier name', async () => {
    const c = await createCampaign(pool, {
      ...base,
      recipients: [
        { contactId: null, debtorId: null, supplierId: fixtureSupplierId, phoneIntl: '97250009', payload: 'hi supplier' },
      ],
    });
    expect(c.total_count).toBe(1);
    const raw = (await rawRecipients(c.id))[0]!;
    expect(raw.contact_id).toBeNull();
    expect(raw.supplier_id).toBe(fixtureSupplierId);

    const log = await listRecipients(pool, c.id);
    expect(log.rows[0]?.debtor_name).toBe('wa-queue test supplier');
  });

  // PR ב': a consolidated (debt-message) recipient carries `apartments` —
  // every apartment it covers becomes a wa_campaign_recipient_apartments row,
  // on top of the recipient's own representative contact_id/debtor_id (which
  // stays exactly what it was before this feature: the parent row's own FK).
  it('writes one wa_campaign_recipient_apartments row per apartment for a consolidated recipient', async () => {
    const c = await createCampaign(pool, {
      ...base,
      recipients: [
        { contactId: fixtureContactId, debtorId: null, phoneIntl: '97250001', payload: 'consolidated', apartments: [
          { contactId: fixtureContactId, debtorId: null },
          { contactId: fixtureContactId2, debtorId: null },
        ] },
      ],
    });
    expect(c.total_count).toBe(1);
    const rows = await pool.query<{ contact_id: string }>(
      `select ra.contact_id from public.wa_campaign_recipient_apartments ra
       join public.wa_campaign_recipients r on r.id = ra.recipient_id
       where r.campaign_id = $1 order by ra.contact_id`,
      [c.id],
    );
    expect(rows.rows.map((r) => r.contact_id).sort()).toEqual([fixtureContactId, fixtureContactId2].sort());
  });

  // A free-form recipient (no `apartments`) must write ZERO link rows — the
  // free path stays exactly as it was before wa_campaign_recipient_apartments
  // existed at all, byte-for-byte, schema-writes included.
  it('writes NO wa_campaign_recipient_apartments rows for a free-form recipient', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    const rows = await pool.query(
      `select 1 from public.wa_campaign_recipient_apartments ra
       join public.wa_campaign_recipients r on r.id = ra.recipient_id
       where r.campaign_id = $1`,
      [c.id],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('is idempotent on client_token (double create → same campaign)', async () => {
    const a = await createCampaign(pool, { ...base, recipients: recips('97250001'), clientToken: 'tok-1' });
    const b = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002'), clientToken: 'tok-1' });
    expect(b.id).toBe(a.id);
    expect(b.total_count).toBe(1);
  });

  it('drains happily: every recipient sent exactly once; campaign completed', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002', '97250003') });
    await startCampaign(pool, c.id);
    const mock = new MockProvider();
    await drain(mockWorker(mock));
    const done = await getCampaign(pool, c.id);
    expect(done!.status).toBe('completed');
    expect(done!.sent_count).toBe(3);
    for (const p of ['97250001', '97250002', '97250003']) expect(mock.countFor(p)).toBe(1);
  });

  it('atomic claim: two concurrent workers never double-claim', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips(...Array.from({ length: 20 }, (_, i) => `9725${1000 + i}`)) });
    await startCampaign(pool, c.id);
    const [a, b] = await Promise.all([
      claimBatch(pool, { workerId: 'A', batchSize: 20 }),
      claimBatch(pool, { workerId: 'B', batchSize: 20 }),
    ]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(20);
  });

  it('retries a transient failure then succeeds (bounded attempts)', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    await startCampaign(pool, c.id);
    const mock = new MockProvider({ failTimes: { '97250001': 2 } });
    await drain(mockWorker(mock));
    const [r] = await rawRecipients(c.id);
    expect(r.status).toBe('sent');
    expect(r.attempt_count).toBe(3);
    expect(mock.countFor('97250001')).toBe(3);
  });

  it('does not retry a permanent (auth) failure; completed_with_errors', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    const mock = new MockProvider({ fail: { '97250001': { status: 401, message: 'unauthorized' } } });
    await drain(mockWorker(mock));
    const done = await getCampaign(pool, c.id);
    expect(done!.status).toBe('completed_with_errors');
    expect(done!.failed_count).toBe(1);
    expect(done!.sent_count).toBe(1);
    const failed = (await rawRecipients(c.id, 'failed'))[0];
    expect(failed.error_class).toBe('auth');
    expect(failed.attempt_count).toBe(1);
  });

  it('lease recovery — crash BEFORE send re-queues (no duplicate)', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    await startCampaign(pool, c.id);
    const [item] = await claimBatch(pool, { workerId: 'dead', batchSize: 1, leaseSec: 60 });
    await pool.query(`update public.wa_campaign_recipients set lease_expires_at=now()-interval '1s', send_attempted_at=null where id=$1`, [item.id]);
    const rec = await recoverLeases(pool);
    expect(rec.requeued).toBe(1);
    expect(rec.indeterminate).toBe(0);
    const mock = new MockProvider();
    await drain(mockWorker(mock, 'w2'));
    expect(mock.countFor('97250001')).toBe(1);
  });

  it('lease recovery — crash AFTER send is indeterminate, NOT auto-resent', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    await startCampaign(pool, c.id);
    const [item] = await claimBatch(pool, { workerId: 'dead', batchSize: 1, leaseSec: 60 });
    await pool.query(`update public.wa_campaign_recipients set lease_expires_at=now()-interval '1s', send_attempted_at=now() where id=$1`, [item.id]);
    const rec = await recoverLeases(pool);
    expect(rec.indeterminate).toBe(1);
    const mock = new MockProvider();
    await drain(mockWorker(mock, 'w2'));
    const [r] = await rawRecipients(c.id);
    expect(r.status).toBe('failed');
    expect(r.error_class).toBe('indeterminate');
    expect(mock.countFor('97250001')).toBe(0);
  });

  it('deployment interruption: restart mid-drain sends each recipient at most once', async () => {
    const phones = Array.from({ length: 10 }, (_, i) => `9725${2000 + i}`);
    const c = await createCampaign(pool, { ...base, recipients: recips(...phones) });
    await startCampaign(pool, c.id);
    const mock1 = new MockProvider();
    const w1 = mockWorker(mock1, 'w1', 60);
    await w1.tick();
    await w1.tick();
    await pool.query(`update public.wa_campaign_recipients set lease_expires_at=now()-interval '1s' where status='processing'`);
    const mock2 = new MockProvider();
    await drain(mockWorker(mock2, 'w2', 60));
    const done = await getCampaign(pool, c.id);
    for (const p of phones) expect(mock1.countFor(p) + mock2.countFor(p)).toBeLessThanOrEqual(1);
    expect(['completed', 'completed_with_errors']).toContain(done!.status);
    expect(done!.pending_count).toBe(0);
    expect(done!.processing_count).toBe(0);
  });

  it('pause stops new claims; resume continues', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    await pauseCampaign(pool, c.id);
    expect((await claimBatch(pool, { workerId: 'w', batchSize: 10 })).length).toBe(0);
    await resumeCampaign(pool, c.id);
    await drain(mockWorker(new MockProvider()));
    expect((await getCampaign(pool, c.id))!.sent_count).toBe(2);
  });

  it('cancel prevents pending sends', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    await cancelCampaign(pool, c.id);
    const mock = new MockProvider();
    await drain(mockWorker(mock));
    expect(mock.sends.length).toBe(0);
    const done = await getCampaign(pool, c.id);
    expect(done!.status).toBe('cancelled');
    expect(done!.cancelled_count).toBe(2);
  });

  it('retry_failed requeues failed items without touching sent ones', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    await drain(mockWorker(new MockProvider({ fail: { '97250001': { status: 400, message: 'bad' } } })));
    expect((await getCampaign(pool, c.id))!.failed_count).toBe(1);
    const res = await retryFailed(pool, c.id);
    expect(res.requeued).toBe(1);
    const mock2 = new MockProvider();
    await drain(mockWorker(mock2, 'w2'));
    const done = await getCampaign(pool, c.id);
    expect(done!.status).toBe('completed');
    expect(done!.sent_count).toBe(2);
    expect(mock2.countFor('97250002')).toBe(0);
  });

  it('duplicate workers on the same campaign send each recipient once', async () => {
    const phones = Array.from({ length: 12 }, (_, i) => `9725${3000 + i}`);
    const c = await createCampaign(pool, { ...base, recipients: recips(...phones) });
    await startCampaign(pool, c.id);
    const m1 = new MockProvider(); const m2 = new MockProvider();
    await Promise.all([drain(mockWorker(m1, 'wA')), drain(mockWorker(m2, 'wB'))]);
    for (const p of phones) expect(m1.countFor(p) + m2.countFor(p)).toBe(1);
    expect((await getCampaign(pool, c.id))!.sent_count).toBe(12);
  });

  it('stale reconciliation rolls up a running campaign whose work is all done', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    await startCampaign(pool, c.id);
    await pool.query(`update public.wa_campaign_recipients set status='sent', sent_at=now() where campaign_id=$1`, [c.id]);
    await reconcileStale(pool);
    expect((await getCampaign(pool, c.id))!.status).toBe('completed');
  });

  it('counter reconciliation repairs drifted counters from row truth', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    await pool.query(`update public.wa_campaigns set sent_count=999, pending_count=999 where id=$1`, [c.id]);
    await reconcileStale(pool);
    const r = await getCampaign(pool, c.id);
    expect(r!.sent_count).toBe(0);
    expect(r!.pending_count).toBe(2);
  });

  it('shared rate limit paces sends within the window', async () => {
    const phones = Array.from({ length: 10 }, (_, i) => `9725${4000 + i}`);
    const c = await createCampaign(pool, { ...base, ratePerMin: 3, recipients: recips(...phones) });
    await startCampaign(pool, c.id);
    const w = new DeliveryWorker({ pool, workerId: 'w', batchSize: 10, makeProviderFor: () => new MockProvider(), idlePollMs: 5 });
    await w.tick();
    const sent = await pool.query<{ n: string }>(`select count(*)::int n from public.wa_campaign_recipients where campaign_id=$1 and status='sent'`, [c.id]);
    expect(Number(sent.rows[0].n)).toBeLessThanOrEqual(3);
  });

  it('rejects invalid state transitions with a conflict', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001') });
    await startCampaign(pool, c.id);
    await cancelCampaign(pool, c.id);
    await expect(startCampaign(pool, c.id)).rejects.toBeInstanceOf(CampaignConflictError);
    await expect(pauseCampaign(pool, c.id)).rejects.toBeInstanceOf(CampaignConflictError);
  });

  it('cancel is idempotent: repeated cancels never change the counters', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002') });
    await startCampaign(pool, c.id);
    const first = await cancelCampaign(pool, c.id);
    const second = await cancelCampaign(pool, c.id);   // no throw, no-op
    const third = await cancelCampaign(pool, c.id);
    expect(first.status).toBe('cancelled');
    expect(second.status).toBe('cancelled');
    expect(third.cancelled_count).toBe(first.cancelled_count); // stable
    expect(third.sent_count).toBe(first.sent_count);
  });

  it('cancel while sending: in-flight send lands as sent, the rest cancelled, sent stays sent', async () => {
    // 3 recipients; worker sends one (latency lets us cancel mid-flight).
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002', '97250003') });
    await startCampaign(pool, c.id);
    const mock = new MockProvider({ latencyMs: 60 });
    const worker = new DeliveryWorker({ pool, workerId: 'w1', batchSize: 1, makeProviderFor: () => mock, idlePollMs: 5 });
    const inFlight = worker.tick();                    // claims + sends recipient #1 (60ms)
    await new Promise((r) => setTimeout(r, 20));        // cancel DURING that provider call
    await cancelCampaign(pool, c.id);
    await inFlight;                                      // the in-flight send completes → 'sent'
    await drain(mockWorker(mock, 'w2'));                // no further sends possible
    const done = await getCampaign(pool, c.id);
    expect(done!.status).toBe('cancelled');
    // The one already handed to the provider is 'sent' and NEVER flipped to cancelled.
    const sent = await rawRecipients(c.id, 'sent');
    expect(sent.length).toBe(1);
    expect(mock.countFor(sent[0].phone_intl)).toBe(1);
    // Every untouched recipient is cancelled; nobody is left pending/processing.
    expect(done!.pending_count).toBe(0);
    expect(done!.processing_count).toBe(0);
    expect(done!.sent_count + done!.cancelled_count + done!.failed_count).toBe(3);
    // Exactly-once: no phone was sent twice across both workers.
    for (const p of ['97250001', '97250002', '97250003']) expect(mock.countFor(p)).toBeLessThanOrEqual(1);
  });

  it('counter invariant holds after cancel: total = pending+processing+sent+failed+cancelled', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('97250001', '97250002', '97250003', '97250004') });
    await startCampaign(pool, c.id);
    await drain(mockWorker(new MockProvider({ fail: { '97250001': { status: 400, message: 'bad' } } })), 2); // partial
    await cancelCampaign(pool, c.id);
    const d2 = (await getCampaign(pool, c.id))!;
    expect(d2.pending_count + d2.processing_count + d2.sent_count + d2.failed_count + d2.cancelled_count)
      .toBe(d2.total_count);
    expect(d2.total_count).toBe(4);
  });

  it('recipient log view: paginates, filters, and masks the phone', async () => {
    const c = await createCampaign(pool, { ...base, recipients: recips('972501111111', '972502222222', '972503333333') });
    const page = await listRecipients(pool, c.id, { limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.rows.length).toBe(2);
    // masked: keep prefix + last 2, bullet the middle — never the raw number.
    expect(page.rows[0].phone_masked).toMatch(/^\d{3}-•••-••\d{2}$/);
    expect(page.rows[0].phone_masked).not.toContain('972');
    const pending = await listRecipients(pool, c.id, { status: 'pending' });
    expect(pending.total).toBe(3);
  });

  // ── Attachments ─────────────────────────────────────────────────────────────
  async function stage(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, name] of names.entries()) {
      const r = await pool.query<{ id: string }>(
        `insert into public.wa_campaign_attachments (uploaded_by, bucket, object_key, original_name, mime_type, size_bytes)
         values ($1, 'whatsapp-attachments', $2, $3, 'application/pdf', 1000) returning id`,
        [OWNER, `${'0000000'.slice(String(i).length)}${i}-0000-4000-8000-000000000000.pdf`, name]);
      ids.push(r.rows[0].id);
    }
    return ids;
  }
  const OWNER = '22222222-2222-2222-2222-222222222222';
  const reader = async () => Buffer.from('%PDF-1.4');

  it('attachments: uploaded to Green ONCE per campaign, then text + files per recipient in order', async () => {
    const ids = await stage(['א.pdf', 'ב.pdf']);
    const c = await createCampaign(pool, { ...base, createdBy: OWNER, recipients: recips('97250001', '97250002'), attachmentIds: ids });
    await startCampaign(pool, c.id);
    const mock = new MockProvider();
    const worker = new DeliveryWorker({ pool, workerId: 'w1', makeProviderFor: () => mock, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader });
    await drain(worker);
    expect((await getCampaign(pool, c.id))!.status).toBe('completed');
    // one upload per file, not per recipient
    expect(mock.uploads.length).toBe(2);
    // per recipient: text, then file 0, then file 1 — by the shared link
    const for1 = mock.sends.filter((s) => s.chatId === '97250001@c.us');
    expect(for1.map((s) => [s.kind, s.fileName ?? s.message])).toEqual([['text', 'hi 97250001'], ['file_url', 'א.pdf'], ['file_url', 'ב.pdf']]);
    const rows = await rawRecipients(c.id);
    for (const r of rows) { expect(r.status).toBe('sent'); expect(r.attachments_sent).toBe(2); expect(r.provider_message_id).toBeTruthy(); }
  });

  it('attachments: every file of a multi-file broadcast reaches every recipient, in order', async () => {
    const ids = await stage(['א.pdf', 'ב.pdf', 'ג.pdf']);
    const c = await createCampaign(pool, { ...base, createdBy: OWNER, recipients: recips('97250001', '97250002'), attachmentIds: ids });
    await startCampaign(pool, c.id);
    const mock = new MockProvider();
    await drain(new DeliveryWorker({ pool, workerId: 'w1', makeProviderFor: () => mock, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader }));
    expect((await getCampaign(pool, c.id))!.status).toBe('completed');
    // three files → three uploads for the whole campaign, not three per recipient
    expect(mock.uploads.length).toBe(3);
    expect(new Set(mock.uploads).size).toBe(3);
    for (const phone of ['97250001', '97250002']) {
      const sent = mock.sends.filter((s) => s.chatId === `${phone}@c.us`);
      expect(sent.map((s) => [s.kind, s.fileName ?? s.message])).toEqual([
        ['text', `hi ${phone}`], ['file_url', 'א.pdf'], ['file_url', 'ב.pdf'], ['file_url', 'ג.pdf'],
      ]);
    }
    const rows = await rawRecipients(c.id);
    expect(rows.map((r) => r.attachments_sent)).toEqual([3, 3]);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
  });

  it('attachments: a single file carries the text as its caption', async () => {
    const ids = await stage(['חשבון.pdf']);
    const c = await createCampaign(pool, { ...base, createdBy: OWNER, recipients: recips('97250001'), attachmentIds: ids });
    await startCampaign(pool, c.id);
    const mock = new MockProvider();
    await drain(new DeliveryWorker({ pool, workerId: 'w1', makeProviderFor: () => mock, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader }));
    expect(mock.sends).toEqual([{ chatId: '97250001@c.us', message: 'hi 97250001', kind: 'file_url', fileName: 'חשבון.pdf' }]);
  });

  it('attachments: a failing file marks the recipient failed with the file named, and a retry resumes without re-sending the text', async () => {
    const ids = await stage(['ok.pdf', 'bad.pdf']);
    const c = await createCampaign(pool, { ...base, createdBy: OWNER, recipients: recips('97250001'), attachmentIds: ids });
    await startCampaign(pool, c.id);
    const mock = new MockProvider({ failFile: { 'bad.pdf': { status: 400, message: 'rejected' } } });
    const worker = new DeliveryWorker({ pool, workerId: 'w1', makeProviderFor: () => mock, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader });
    await drain(worker);
    let [r] = await rawRecipients(c.id);
    expect(r.status).toBe('failed');
    expect(r.last_error).toContain('bad.pdf');
    expect(r.attachments_sent).toBe(1);          // text + ok.pdf delivered
    expect(mock.countFor('97250001')).toBe(3);   // text, ok.pdf, bad.pdf (failed)
    // operator retry after the file is fixed: only bad.pdf goes out again
    const fixed = new MockProvider();
    await retryFailed(pool, c.id);
    await drain(new DeliveryWorker({ pool, workerId: 'w2', makeProviderFor: () => fixed, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader }));
    [r] = await rawRecipients(c.id);
    expect(r.status).toBe('sent');
    expect(fixed.sends.map((s) => s.fileName)).toEqual(['bad.pdf']);
  });

  it('attachments: when uploadFile keeps failing the file is sent per recipient by upload', async () => {
    const ids = await stage(['x.pdf']);
    const c = await createCampaign(pool, { ...base, createdBy: OWNER, recipients: recips('97250001', '97250002'), attachmentIds: ids });
    await startCampaign(pool, c.id);
    const mock = new MockProvider({ failUpload: true });
    await drain(new DeliveryWorker({ pool, workerId: 'w1', makeProviderFor: () => mock, idlePollMs: 5, backoffBaseSec: 0, readAttachment: reader }));
    expect((await getCampaign(pool, c.id))!.status).toBe('completed');
    // The shared upload is retried on later ticks (up to MAX_UPLOAD_ATTEMPTS), but
    // a recipient never waits for it: with no usable link it goes out by upload.
    expect(mock.uploads.length).toBeGreaterThanOrEqual(1);
    expect(mock.uploads.length).toBeLessThanOrEqual(3);
    expect(mock.sends.filter((s) => s.kind === 'file_upload').length).toBe(2);
    expect(mock.sends.filter((s) => s.kind === 'file_url').length).toBe(0);
  });

  it('attachments: linking refuses a file that is not the creator\'s staged upload', async () => {
    const ids = await stage(['x.pdf']);
    await expect(createCampaign(pool, { ...base, createdBy: '33333333-3333-3333-3333-333333333333', recipients: recips('97250001'), attachmentIds: ids }))
      .rejects.toBeInstanceOf(CampaignConflictError);
  });
});

// RBAC — the exact gate the campaign routes enforce (whatsapp_chat view/edit).
describe('wa-queue RBAC', () => {
  it('denies a viewer, allows a manager, admin/super_admin bypass', () => {
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'whatsapp_chat', 'edit')).toBe(false);
    expect(hasPermission('viewer', DEFAULT_VIEWER, 'whatsapp_chat', 'view')).toBe(false);
    expect(hasPermission('manager', DEFAULT_MANAGER, 'whatsapp_chat', 'edit')).toBe(true);
    expect(hasPermission('admin', [], 'whatsapp_chat', 'edit')).toBe(true);
    expect(hasPermission('super_admin', [], 'whatsapp_chat', 'edit')).toBe(true);
  });
});

// Pure logic (no DB) — backoff curve + error classification.
describe('wa-queue backoff + classification', () => {
  it('backoff grows exponentially and caps', () => {
    expect(backoffSeconds(1, 5, 300)).toBeGreaterThanOrEqual(5);
    expect(backoffSeconds(1, 5, 300)).toBeLessThan(8);      // 5 + <25% jitter
    expect(backoffSeconds(4, 5, 300)).toBeGreaterThanOrEqual(40); // 5*2^3
    expect(backoffSeconds(20, 5, 300)).toBeLessThanOrEqual(300);  // capped
    expect(backoffSeconds(1, 0)).toBe(0);                   // zero base → immediate
  });
  it('classifies retryable vs permanent errors', () => {
    expect(classifyError(new Error('timeout')).retryable).toBe(true);
    expect(classifyError(new Error('x'), { status: 500 }).retryable).toBe(true);
    expect(classifyError(new Error('x'), { status: 429 }).errorClass).toBe('rate_limited');
    expect(classifyError(new Error('unauthorized'), { status: 401 }).retryable).toBe(false);
    expect(classifyError(new Error('x'), { status: 400 }).retryable).toBe(false);
  });

});

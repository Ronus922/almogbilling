import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { Actor } from '@/lib/auth/actor';
import type { DebtorContact } from '@/lib/db/debtors';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';

// DB-level round-trip for the multi-recipient single-send feature (18/10/2026):
// sendAndRecordWhatsApp called once per checked recipient, exactly the way
// POST /api/whatsapp/send's new branch does it — proves the two real risks the
// Phase-0 investigation flagged:
//   1. wa_message_attachments.message_id is one-shot — the SECOND recipient
//      must get a CLONED row (cloneStagedMessageAttachment), not the original.
//   2. the physical Green API upload happens exactly ONCE, shared across
//      every recipient — the clone carries the already-resolved link.
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod —
// same gate as tests/wa-queue.test.ts / tests/wa-attachments-staged.test.ts.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  withTransaction: async (fn: (client: Pool) => Promise<unknown>) => {
    // The real withTransaction wraps a PoolClient; a plain Pool satisfies the
    // same .query() surface every call site here actually uses.
    return fn(pool);
  },
}));
// No real Supabase Storage in this test — only reached when a row has no
// usable Green API link yet (hasUsableUrl false), to read the bytes for the
// (stubbed) upload. PRIVATE_BUCKETS stays real: whatsapp-send.ts checks
// membership in it.
vi.mock('@/lib/storage/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/storage/server')>();
  return {
    ...real,
    getObjectStream: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
    // cloneWhatsAppAttachment (for recipient 2+) re-uploads the bytes under a
    // fresh key — no real Storage reachable in this test, so this is a no-op.
    uploadObject: async () => undefined,
  };
});

const { sendAndRecordWhatsApp, ensureAttachmentLinks } = await import('@/lib/whatsapp-send');
const {
  insertStagedMessageAttachment, cloneStagedMessageAttachment, listMessageAttachments,
} = await import('@/lib/db/whatsappMessageAttachments');

/** Every id this suite creates, so teardown removes exactly those (CLAUDE.md
 *  iron rule 12 — never clean up by filter). */
const made = {
  users: [] as string[], instances: [] as string[], debtors: [] as string[],
  messages: [] as string[], attachments: [] as string[],
};

let n = 0;
const uniq = () => `${Date.now()}-${n++}`;

d('multi-recipient single-send: the real fan-out, against a real DB', () => {
  let actor: Actor;
  let creds: InstanceCreds;
  let debtor: DebtorContact;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);

    const u = await pool.query<{ id: string }>(
      `insert into public.users (username, email, full_name, password_hash, role)
       values ($1, $1, 'מבדיקה', 'x', 'admin') returning id`,
      [`wa-multi-test-${uniq()}@example.invalid`],
    );
    made.users.push(u.rows[0].id);
    actor = {
      id: u.rows[0].id, username: 'wa-multi-test', email: 'x@example.invalid',
      full_name: 'מבדיקה', role: 'admin', permissions: [], isAuthenticated: true,
    };

    const inst = await pool.query<{ id: string }>(
      `insert into public.whatsapp_instances
         (user_id, display_name, green_instance_id, green_token_enc, api_url, state)
       values ($1, 'test', '000000', '{"iv":"","ct":"","tag":""}'::jsonb, 'https://fake.greenapi.test', 'authorized')
       returning id`,
      [u.rows[0].id],
    );
    made.instances.push(inst.rows[0].id);
    creds = {
      id: inst.rows[0].id, greenInstanceId: '000000', token: 'fake-token',
      apiUrl: 'https://fake.greenapi.test', mediaUrl: null,
    };

    const deb = await pool.query<{ id: string }>(
      `insert into public.debtors (apartment_number) values ($1) returning id`,
      [`wa-multi-${uniq()}`],
    );
    made.debtors.push(deb.rows[0].id);
    debtor = {
      id: deb.rows[0].id, apartment_number: 'wa-multi', owner_name: 'בעל הדירה',
      tenant_name: 'השוכר', phone_owner: '972501110001', phone_tenant: '972501110002',
      total_debt: 100, management_fees: 100, hot_water_debt: 0,
    };
  });

  afterAll(async () => {
    for (const id of made.attachments) await pool.query(`delete from public.wa_message_attachments where id = $1`, [id]);
    for (const id of made.messages) await pool.query(`delete from public.chat_messages where id = $1`, [id]);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.instances) await pool.query(`delete from public.whatsapp_instances where id = $1`, [id]);
    for (const id of made.users) await pool.query(`delete from public.users where id = $1`, [id]);
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGreenApi(): { uploadCalls: number; sendCalls: number } {
    const counts = { uploadCalls: 0, sendCalls: 0 };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (u.includes('/uploadFile/')) {
        counts.uploadCalls++;
        return json({ urlFile: `https://green.example/u-${counts.uploadCalls}` });
      }
      if (u.includes('/sendFileByUrl/')) {
        counts.sendCalls++;
        return json({ idMessage: `file-${counts.sendCalls}` });
      }
      if (u.includes('/sendMessage/')) {
        counts.sendCalls++;
        return json({ idMessage: `text-${counts.sendCalls}` });
      }
      throw new Error(`unexpected fetch in test: ${u} ${init?.method}`);
    }));
    return counts;
  }

  it('two recipients, no attachments: two independent rows, each with its own recipient_name', async () => {
    const counts = stubGreenApi();

    const r1 = await sendAndRecordWhatsApp({
      debtor, phoneIntl: '972501110001', rawMessage: 'שלום', templateId: null,
      actor, creds, recipientName: 'בעלים',
    });
    expect(r1.ok).toBe(true);
    made.messages.push(r1.messageId!);

    const r2 = await sendAndRecordWhatsApp({
      debtor, phoneIntl: '972501110002', rawMessage: 'שלום', templateId: null,
      actor, creds, recipientName: 'שוכר/ת',
    });
    expect(r2.ok).toBe(true);
    made.messages.push(r2.messageId!);

    expect(r1.messageId).not.toBe(r2.messageId);
    expect(counts.sendCalls).toBe(2); // one text send per recipient, no sharing to short-circuit here

    const rows = await pool.query<{ id: string; contact_phone: string; recipient_name: string | null }>(
      `select id, contact_phone, recipient_name from public.chat_messages where id = any($1::uuid[]) order by contact_phone`,
      [[r1.messageId, r2.messageId]],
    );
    expect(rows.rows).toEqual([
      { id: r1.messageId, contact_phone: '972501110001', recipient_name: 'בעלים' },
      { id: r2.messageId, contact_phone: '972501110002', recipient_name: 'שוכר/ת' },
    ]);
  });

  it('two recipients WITH an attachment: the file uploads once, each recipient gets its own linked row', async () => {
    const counts = stubGreenApi();

    const staged = await insertStagedMessageAttachment({
      uploadedBy: actor.id, bucket: 'whatsapp-attachments', objectKey: `${uniq()}.pdf`,
      originalName: 'חוזה.pdf', mimeType: 'application/pdf', sizeBytes: 123,
    });
    made.attachments.push(staged.id);

    // Mirrors the route: upload once, up front.
    const { ready, failed } = await ensureAttachmentLinks([staged], creds);
    expect(failed).toEqual([]);
    expect(ready).toHaveLength(1);
    expect(counts.uploadCalls).toBe(1);

    // Recipient 1 reuses the ORIGINAL row (its green_api_url patched in, same as
    // the route does) — claims it via the transaction inside sendAndRecordWhatsApp.
    const row1 = { ...ready[0].row, green_api_url: ready[0].urlFile };
    const r1 = await sendAndRecordWhatsApp({
      debtor, phoneIntl: '972501110001', rawMessage: '', templateId: null,
      actor, creds, attachments: [row1], recipientName: 'בעלים',
    });
    expect(r1.ok).toBe(true);
    made.messages.push(r1.messageId!);
    // Still exactly one upload — recipient 1 reused the already-resolved link.
    expect(counts.uploadCalls).toBe(1);

    // Recipient 2 gets a FRESH clone (message_id is one-shot: the original row
    // is now claimed by r1's message and would resolve to 0 rows linked).
    const clone = await cloneStagedMessageAttachment(ready[0].row, actor.id, ready[0].urlFile);
    made.attachments.push(clone.id);
    expect(clone.id).not.toBe(staged.id);

    const r2 = await sendAndRecordWhatsApp({
      debtor, phoneIntl: '972501110002', rawMessage: '', templateId: null,
      actor, creds, attachments: [clone], recipientName: 'שוכר/ת',
    });
    expect(r2.ok).toBe(true);
    made.messages.push(r2.messageId!);
    // The clone's link was reused too — never a second physical upload.
    expect(counts.uploadCalls).toBe(1);

    const atts1 = await listMessageAttachments(r1.messageId!);
    const atts2 = await listMessageAttachments(r2.messageId!);
    expect(atts1.map((a) => a.id)).toEqual([staged.id]);
    expect(atts2.map((a) => a.id)).toEqual([clone.id]);
    // Two independent rows, each with ITS OWN object_key (object_key is UNIQUE —
    // the file-serving proxy looks a row up BY it, so two rows may never share
    // one), but the same already-resolved Green API link (no second upload).
    expect(atts1[0].object_key).not.toBe(atts2[0].object_key);
    expect(atts1[0].green_api_url).toBe(atts2[0].green_api_url);
  });
});

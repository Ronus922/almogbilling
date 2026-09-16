import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

// What happens to a staged WhatsApp attachment after the Storage garbage
// collector removes its object.
//
// The GC deletes the OBJECT and stamps wa_*_attachments.object_deleted_at; the
// ROW is deliberately kept (the job never removes DB data, and the row is the
// last record that the upload existed). These tests pin the consequence: a
// stamped row is invisible to the staged lookups, so a compose sheet left open
// past the 24h staging window is refused — /api/whatsapp/campaigns and
// /api/whatsapp/send both compare the resolved count with the ids they were
// given and answer "קובץ מצורף לא נמצא — הסר אותו וצרף מחדש" — instead of
// broadcasting a file whose bytes are gone.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod —
// the same gate tests/wa-queue.test.ts uses.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;

// whatsappMessageAttachments.ts reaches for the app pool; hand it the test one.
vi.mock('@/lib/db', () => ({ getDbPool: () => pool }));

const { insertStagedAttachment, listStagedAttachments, linkAttachments } = await import('@/lib/wa-queue/attachments');
const { insertStagedMessageAttachment, listStagedMessageAttachments, linkMessageAttachments } =
  await import('@/lib/db/whatsappMessageAttachments');
const { createCampaign } = await import('@/lib/wa-queue/campaigns');

const UPLOADER = '00000000-0000-4000-8000-0000000000aa';

/** Every id this suite creates, so teardown removes exactly those and nothing
 *  else (CLAUDE.md iron rule 12 — never clean up by filter). */
const made = { campaignAtt: [] as string[], messageAtt: [] as string[], campaigns: [] as string[], messages: [] as string[] };

async function stampDeleted(table: 'wa_campaign_attachments' | 'wa_message_attachments', id: string): Promise<void> {
  const r =
    table === 'wa_campaign_attachments'
      ? await pool.query(`update public.wa_campaign_attachments set object_deleted_at = now() where id = $1`, [id])
      : await pool.query(`update public.wa_message_attachments set object_deleted_at = now() where id = $1`, [id]);
  expect(r.rowCount).toBe(1);
}

let n = 0;
const uniq = () => `t${Date.now()}-${n++}`;

d('staged attachments after the Storage GC collected their object', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
    for (const id of made.campaignAtt) await pool.query(`delete from public.wa_campaign_attachments where id = $1`, [id]);
    for (const id of made.messageAtt) await pool.query(`delete from public.wa_message_attachments where id = $1`, [id]);
    for (const id of made.campaigns) await pool.query(`delete from public.wa_campaigns where id = $1`, [id]);
    for (const id of made.messages) await pool.query(`delete from public.chat_messages where id = $1`, [id]);
    await pool.end();
  });

  async function stageCampaignAttachment(): Promise<string> {
    const a = await insertStagedAttachment(pool, {
      uploadedBy: UPLOADER, bucket: 'whatsapp-attachments', objectKey: `${uniq()}.pdf`,
      originalName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10,
    });
    made.campaignAtt.push(a.id);
    return a.id;
  }

  async function stageMessageAttachment(): Promise<string> {
    const a = await insertStagedMessageAttachment({
      uploadedBy: UPLOADER, bucket: 'whatsapp-attachments', objectKey: `${uniq()}.pdf`,
      originalName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10,
    });
    made.messageAtt.push(a.id);
    return a.id;
  }

  it('a fresh staged broadcast attachment resolves, and reports object_deleted_at as null', async () => {
    const id = await stageCampaignAttachment();
    const got = await listStagedAttachments(pool, [id], UPLOADER);
    expect(got.map((a) => a.id)).toEqual([id]);
    expect(got[0].object_deleted_at).toBeNull();
  });

  it('once the object is gone the row stays, but listStagedAttachments no longer offers it', async () => {
    const id = await stageCampaignAttachment();
    await stampDeleted('wa_campaign_attachments', id);

    expect(await listStagedAttachments(pool, [id], UPLOADER)).toEqual([]);
    // The row itself must survive — the GC removes objects, never DB data.
    const row = await pool.query(`select object_deleted_at from public.wa_campaign_attachments where id = $1`, [id]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].object_deleted_at).not.toBeNull();
  });

  it('a stamped file drops out of a mixed list, so the route sees a count mismatch and refuses', async () => {
    const live = await stageCampaignAttachment();
    const dead = await stageCampaignAttachment();
    await stampDeleted('wa_campaign_attachments', dead);

    const got = await listStagedAttachments(pool, [live, dead], UPLOADER);
    expect(got.map((a) => a.id)).toEqual([live]);
    expect(got.length).not.toBe(2); // what POST /api/whatsapp/campaigns checks
  });

  it('linkAttachments refuses a stamped row inside the create transaction', async () => {
    const dead = await stageCampaignAttachment();
    await stampDeleted('wa_campaign_attachments', dead);
    const campaign = await createCampaign(pool, {
      name: 'gc-test', body: 'b', audience: {}, instanceId: null, createdBy: null,
      dryRun: true, ratePerMin: 120, recipients: [],
    });
    made.campaigns.push(campaign.id);

    expect(await linkAttachments(pool, campaign.id, [dead], UPLOADER)).toBe(0);
    const still = await pool.query(`select campaign_id from public.wa_campaign_attachments where id = $1`, [dead]);
    expect(still.rows[0].campaign_id).toBeNull();
  });

  it('the single-message sheet behaves identically', async () => {
    const live = await stageMessageAttachment();
    const dead = await stageMessageAttachment();
    await stampDeleted('wa_message_attachments', dead);

    const got = await listStagedMessageAttachments([live, dead], UPLOADER);
    expect(got.map((a) => a.id)).toEqual([live]);
    expect(got[0].object_deleted_at).toBeNull();
  });

  it('linkMessageAttachments refuses a stamped row', async () => {
    const dead = await stageMessageAttachment();
    await stampDeleted('wa_message_attachments', dead);
    const msg = await pool.query<{ id: string }>(
      `insert into public.chat_messages (contact_phone, direction) values ('972500000000', 'sent') returning id`,
    );
    made.messages.push(msg.rows[0].id);

    expect(await linkMessageAttachments(pool, msg.rows[0].id, [dead], UPLOADER)).toBe(0);
  });

  it('a stamp is idempotent — a second GC pass marks nothing new', async () => {
    const id = await stageCampaignAttachment();
    await stampDeleted('wa_campaign_attachments', id);
    const again = await pool.query(
      `update public.wa_campaign_attachments set object_deleted_at = now()
        where id = any($1::uuid[]) and object_deleted_at is null`,
      [[id]],
    );
    expect(again.rowCount).toBe(0);
  });
});

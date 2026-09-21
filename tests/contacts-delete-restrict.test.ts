import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// wa_campaign_recipients.contact_id is ON DELETE RESTRICT (added alongside the
// contacts-first broadcast base flip): a contact that ever received a WhatsApp
// broadcast can no longer be deleted. This is the DB-level invariant that
// src/app/api/contacts/[id]/route.ts's DELETE handler translates into a Hebrew
// message (code 23503, constraint wa_campaign_recipients_contact_id_fkey).
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;

const made = { contacts: [] as string[], campaigns: [] as string[] };
let n = 0;
const uniqApt = () => `wa-restrict-test-${Date.now()}-${n++}`;

async function makeContact(): Promise<string> {
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number) values ($1) returning id`,
    [uniqApt()],
  );
  made.contacts.push(c.rows[0]!.id);
  return c.rows[0]!.id;
}

d('wa_campaign_recipients.contact_id — ON DELETE RESTRICT', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
    for (const id of made.campaigns) await pool.query(`delete from public.wa_campaigns where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('blocks deleting a contact that has broadcast history, with the expected constraint name', async () => {
    const contactId = await makeContact();
    const campaign = await pool.query<{ id: string }>(
      `insert into public.wa_campaigns (type, status, name, body, audience)
       values ('broadcast','completed','t','b','{}'::jsonb) returning id`,
    );
    const campaignId = campaign.rows[0]!.id;
    made.campaigns.push(campaignId);
    await pool.query(
      `insert into public.wa_campaign_recipients
         (campaign_id, contact_id, phone_intl, chat_id, payload, idempotency_key)
       values ($1, $2, '972500000000', '972500000000@c.us', 'hi', $3)`,
      [campaignId, contactId, `${campaignId}:972500000000`],
    );

    await expect(pool.query(`delete from public.contacts where id = $1`, [contactId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'wa_campaign_recipients_contact_id_fkey' });
  });

  it('allows deleting a contact with no broadcast history', async () => {
    const contactId = await makeContact();
    await pool.query(`delete from public.contacts where id = $1`, [contactId]);
    made.contacts = made.contacts.filter((id) => id !== contactId); // already gone — nothing left to clean up
    const check = await pool.query(`select 1 from public.contacts where id = $1`, [contactId]);
    expect(check.rowCount).toBe(0);
  });
});

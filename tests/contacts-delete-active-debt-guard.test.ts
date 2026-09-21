import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// A BEFORE DELETE trigger on contacts (migration 20260921072925) blocks
// deleting a contact that has an active (non-archived) debtor — an FK can't
// express that condition (debtors.contact_id itself is ON DELETE SET NULL,
// unconditionally). src/app/api/contacts/[id]/route.ts's DELETE handler
// translates this into a Hebrew message (SQLSTATE 'BL001',
// ACTIVE_DEBT_DELETE_BLOCKED_SQLSTATE), including the apartment number.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;

const made = { contacts: [] as string[], debtors: [] as string[] };
let n = 0;
const uniqApt = () => `wa-debt-guard-test-${Date.now()}-${n++}`;

async function makeContact(): Promise<{ id: string; apt: string }> {
  const apt = uniqApt();
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number) values ($1) returning id`,
    [apt],
  );
  made.contacts.push(c.rows[0]!.id);
  return { id: c.rows[0]!.id, apt };
}

async function makeDebtor(contactId: string, apt: string, isArchived: boolean): Promise<string> {
  const debtor = await pool.query<{ id: string }>(
    `insert into public.debtors (apartment_number, contact_id, is_archived)
     values ($1, $2, $3) returning id`,
    [apt, contactId, isArchived],
  );
  made.debtors.push(debtor.rows[0]!.id);
  return debtor.rows[0]!.id;
}

d('contacts delete guard — active debt trigger', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]).catch(() => undefined);
    await pool.end();
  });

  it('blocks deleting a contact with an active debtor, with the apartment number in the message', async () => {
    const { id, apt } = await makeContact();
    await makeDebtor(id, apt, false);

    await expect(pool.query(`delete from public.contacts where id = $1`, [id]))
      .rejects.toMatchObject({ code: 'BL001', message: expect.stringContaining(apt) });
  });

  it('allows deleting a contact whose only debtor is archived', async () => {
    const { id, apt } = await makeContact();
    await makeDebtor(id, apt, true);

    await pool.query(`delete from public.contacts where id = $1`, [id]);
    const check = await pool.query(`select 1 from public.contacts where id = $1`, [id]);
    expect(check.rowCount).toBe(0);
  });

  it('allows deleting a contact with no debtor at all', async () => {
    const { id } = await makeContact();

    await pool.query(`delete from public.contacts where id = $1`, [id]);
    const check = await pool.query(`select 1 from public.contacts where id = $1`, [id]);
    expect(check.rowCount).toBe(0);
  });
});

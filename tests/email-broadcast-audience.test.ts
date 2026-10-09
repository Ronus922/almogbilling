import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

// The email channel's audience (09/10/2026): the same "selection" audience as
// WhatsApp — owners / tenants / suppliers, the "מקבל הודעות" flags, the debt
// filter — reached by email address instead of phone, plus the list of who
// has no usable address ("X עם אימייל / Y ללא"). Then the campaign builder on
// top: placeholders in body AND subject, consolidation per address.
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod.
// The resolvers read the WHOLE contacts table, so every assertion looks only at
// this suite's own fixtures (numeric apartments far from the seed), which are
// removed by id at the end (iron rule 12).
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
// Explicit gate: without a throwaway database these report as SKIPPED, never
// as passed — scripts/check-no-skipped-tests.mjs fails CI if any of them do.
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
vi.mock('@/lib/db', () => ({
  query: (text: string, params?: unknown[]) => pool.query(text, params),
}));

const {
  resolveEmailSelectionRecipients, resolveConsolidatedEmailSelectionRecipients, listSelectionMissingEmail, toEmail,
} = await import('@/lib/whatsapp-broadcast');
const { buildEmailCampaignRecipients, countEmailAudience } = await import('@/lib/email-broadcast');

const made = { contacts: [] as string[], debtors: [] as string[], people: [] as string[], suppliers: [] as string[] };
const RUN = Date.now().toString().slice(-6);
let seq = 0;
const apt = () => `97${RUN}${seq++}`;
const tag = `e${RUN}`;
const addr = (local: string) => `${local}.${tag}@example.com`;

interface Apt {
  owner_name?: string | null; owner_email?: string | null; owner_primary?: boolean;
  tenant_name?: string | null; tenant_email?: string | null; tenant_primary?: boolean;
  debt?: number;
}

async function makeApt(spec: Apt): Promise<{ id: string; apartment: string }> {
  const apartment = apt();
  const c = await pool.query<{ id: string }>(
    `insert into public.contacts
       (apartment_number, owner_name, owner_email, owner_is_primary_contact,
        tenant_name, tenant_email, tenant_is_primary_contact)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [apartment, spec.owner_name ?? null, spec.owner_email ?? null, spec.owner_primary ?? true,
     spec.tenant_name ?? null, spec.tenant_email ?? null, spec.tenant_primary ?? false],
  );
  const id = c.rows[0].id;
  made.contacts.push(id);
  if (spec.debt !== undefined) {
    const dbt = await pool.query<{ id: string }>(
      `insert into public.debtors (apartment_number, contact_id, is_archived, total_debt)
       values ($1, $2, false, $3) returning id`, [apartment, id, spec.debt]);
    made.debtors.push(dbt.rows[0].id);
  }
  return { id, apartment };
}

async function makePerson(contactId: string, role: 'owner' | 'tenant', name: string, email: string | null, primary = true) {
  const r = await pool.query<{ id: string }>(
    `insert into public.contact_people (contact_id, role, name, email, is_primary_contact, sort_order)
     values ($1, $2, $3, $4, $5, 0) returning id`, [contactId, role, name, email, primary]);
  made.people.push(r.rows[0].id);
}

async function makeSupplier(name: string, email: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.suppliers (display_name, email, status) values ($1, $2, 'active') returning id`, [name, email]);
  made.suppliers.push(r.rows[0].id);
  return r.rows[0].id;
}

let A: { id: string; apartment: string };
let B: { id: string; apartment: string };
let C: { id: string; apartment: string };
let D: { id: string; apartment: string };

d('email channel — audience by address', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => {});
    // A: owner with an address typed in mixed case and padded; a tenant
    //    (opted in) with a name but no address; debt 500.
    A = await makeApt({ owner_name: 'בעלים א', owner_email: `  ${addr('Owner.A').toUpperCase()} `, tenant_name: 'שוכר א', tenant_primary: true, debt: 500 });
    // B: owner without an address (opted in); an extra owner with one and an
    //    extra owner without; no debt record at all.
    B = await makeApt({ owner_name: 'בלי מייל' });
    await makePerson(B.id, 'owner', 'נוסף עם מייל', addr('extra.b'));
    await makePerson(B.id, 'owner', 'נוסף בלי מייל', null);
    // C: owner opted OUT ("מקבל הודעות" off) — in neither list.
    C = await makeApt({ owner_name: 'לא מקבל', owner_email: addr('optout.c'), owner_primary: false, debt: 900 });
    // D: the same mailbox as A's owner → one address, two apartments.
    D = await makeApt({ owner_name: 'בעלים א', owner_email: addr('owner.a'), debt: 250 });
    await makeSupplier(`ספק עם מייל ${tag}`, addr('supplier'));
    await makeSupplier(`ספק בלי מייל ${tag}`, '');
  });

  afterAll(async () => {
    if (!pool) return;
    for (const id of made.people) await pool.query(`delete from public.contact_people where id = $1`, [id]);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    for (const id of made.suppliers) await pool.query(`delete from public.suppliers where id = $1`, [id]);
    await pool.end();
  });

  const mine = (email: string) => email.endsWith(`.${tag}@example.com`);
  const fixtureApts = () => new Set([A.apartment, B.apartment, C.apartment, D.apartment]);

  it('toEmail: one well-formed address, lower-cased and trimmed — anything else is no address', () => {
    expect(toEmail('  Ronen@Example.COM ')).toBe('ronen@example.com');
    expect(toEmail('')).toBeNull();
    expect(toEmail(null)).toBeNull();
    expect(toEmail('not-an-email')).toBeNull();
    expect(toEmail('a@b.co, c@d.co')).toBeNull();
  });

  it('owners: one recipient per address (case-insensitive), extras with an address join, opt-out excluded', async () => {
    const list = (await resolveEmailSelectionRecipients(['owners'])).filter((r) => mine(r.email));
    const emails = list.map((r) => r.email).sort();
    expect(emails).toEqual([addr('extra.b'), addr('owner.a')].sort());
    expect(emails).not.toContain(addr('optout.c'));
  });

  it('the missing list: opted-in people with no usable address — not the opted-out, not the empty slots', async () => {
    const missing = (await listSelectionMissingEmail(['owners', 'tenants'])).filter((m) => m.apartment_number && fixtureApts().has(m.apartment_number));
    expect(missing).toEqual(expect.arrayContaining([
      { role: 'owner', apartment_number: B.apartment, name: 'בלי מייל' },
      { role: 'owner', apartment_number: B.apartment, name: 'נוסף בלי מייל' },
      { role: 'tenant', apartment_number: A.apartment, name: 'שוכר א' },
    ]));
    expect(missing).toHaveLength(3);
    // C's owner opted out; D/A owners have an address; B/C/D have no tenant at all.
  });

  it('the debt filter applies to both lists, per apartment', async () => {
    const filter = { only_with_debt: true as const, min_debt_amount: 100 };
    const list = (await resolveEmailSelectionRecipients(['owners'], filter)).filter((r) => mine(r.email));
    expect(list.map((r) => r.email)).toEqual([addr('owner.a')]); // B has no debt → its extra drops out
    const missing = (await listSelectionMissingEmail(['owners', 'tenants'], filter)).filter((m) => m.apartment_number && fixtureApts().has(m.apartment_number));
    expect(missing).toEqual([{ role: 'tenant', apartment_number: A.apartment, name: 'שוכר א' }]);
  });

  it('suppliers: their own email field; a supplier without one is listed as missing', async () => {
    const list = (await resolveEmailSelectionRecipients(['suppliers'])).filter((r) => mine(r.email));
    expect(list).toEqual([expect.objectContaining({ kind: 'supplier', email: addr('supplier'), name: `ספק עם מייל ${tag}` })]);
    const missing = (await listSelectionMissingEmail(['suppliers'])).filter((m) => m.name?.includes(tag));
    expect(missing).toEqual([{ role: 'supplier', apartment_number: null, name: `ספק בלי מייל ${tag}` }]);
  });

  it('a debt message consolidates per address — both apartments of the shared mailbox', async () => {
    const list = (await resolveConsolidatedEmailSelectionRecipients(['owners'])).filter((r) => mine(r.email));
    const shared = list.find((r) => r.email === addr('owner.a'))!;
    expect(shared.apartments.map((a) => a.apartment_number).sort()).toEqual([A.apartment, D.apartment].sort());
  });

  it('campaign recipients: placeholders in body AND subject, the address on the row, no phone', async () => {
    const free = await buildEmailCampaignRecipients({
      roles: ['owners'], debtFilter: { only_with_debt: true, min_debt_amount: 100 },
      body: 'שלום {{name}}', subject: 'הודעה לדירה {{apartment}}\nמהנהלה',
    });
    expect(free.ok).toBe(true);
    const r = free.ok ? free.recipients.find((x) => x.email === addr('owner.a'))! : null;
    expect(r).toMatchObject({ phoneIntl: '', payload: 'שלום בעלים א' });
    expect([`הודעה לדירה ${A.apartment} מהנהלה`, `הודעה לדירה ${D.apartment} מהנהלה`]).toContain(r!.subject);

    const debt = await buildEmailCampaignRecipients({
      roles: ['owners'], debtFilter: undefined,
      body: 'שלום {{name}}{{#apartments}}\nדירה {{apartment}}: {{debt}}{{/apartments}}', subject: 'חוב כולל {{total_debt}}',
    });
    expect(debt.ok).toBe(true);
    const shared = debt.ok ? debt.recipients.find((x) => x.email === addr('owner.a'))! : null;
    expect(shared!.subject).toBe('חוב כולל ₪ 750');
    expect(shared!.payload).toContain(`דירה ${A.apartment}: ₪ 500`);
    expect(shared!.payload).toContain(`דירה ${D.apartment}: ₪ 250`);
    expect(shared!.apartments).toHaveLength(2);
  });

  it('{{apartment}} in the subject of a debt message is blocked when an address holds several apartments', async () => {
    const r = await buildEmailCampaignRecipients({
      roles: ['owners'], debtFilter: undefined, body: '{{debt}}', subject: 'דירה {{apartment}}',
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/\{\{apartment\}\} מחוץ לקטע החוזר/);
  });

  it('the live estimate: count of addresses + the missing list', async () => {
    const est = await countEmailAudience({ roles: ['owners'], debtFilter: undefined, body: 'שלום', subject: 'נושא' });
    expect(est.count).toBe((await resolveEmailSelectionRecipients(['owners'])).length);
    expect(est.missing.some((m) => m.apartment_number === B.apartment && m.name === 'בלי מייל')).toBe(true);
    expect(est.partialCount).toBe(0);
  });
});

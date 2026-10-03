import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';
import { splitOwnerTenantNames } from '@/lib/sync/reportNames';

// Bllink PROPOSES, Ronen APPROVES (29/09/2026).
//
// Until today the debt pipeline reached the residents list through one call
// that could only INSERT a missing apartment — an existing one was never
// updated, not even an empty field. Safe, and silent: a phone changing in
// Bllink was never heard of again.
//
// What is pinned here is the whole rule, exercised through the real data-layer
// entry point (syncContactsFromReport — what the Bllink sync and the Excel
// import both call), not through hand-written SQL:
//   • the same value in a different spelling is not a change;
//   • an empty NAME or ADDRESS field of ours is filled with no approval — a
//     PHONE never is (03/10/2026): a phone opens the portal, so even for an
//     empty field it arrives as a suggestion;
//   • a CONFLICT becomes a suggestion and OURS STANDS;
//   • an empty value from Bllink changes nothing;
//   • two syncs in a row leave ONE suggestion, with its original date;
//   • a rejected value does not come back until Bllink changes it again;
//   • a suggestion our own edit satisfies closes itself;
//   • approving an owner phone puts that owner on the portal roster at once —
//     the promise of PR #50, now reachable from the approval queue too.
// The portal-access rules of the queue (several ids, owner names, Bllink's
// people) are pinned in tests/portal-roles-identity.test.ts.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;

vi.mock('@/lib/db', () => ({
  getDbPool: () => pool,
  query: (text: string, params?: unknown[]) => pool.query(text, params),
  queryOne: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows[0] ?? null,
  withTransaction: async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
}));

const { syncContactsFromReport } = await import('@/lib/db/contacts');
const { listPendingSuggestions, resolveSuggestions, getContactFieldState } =
  await import('@/lib/db/contactSuggestions');
const { findPortalRegistration } = await import('@/lib/db/portal/identity');

// Apartments this file creates. Removed by these exact strings (iron rule 12).
// Numeric on purpose: the registry keys on digits only
// (normalizeApartmentNumber), so a lettered fixture would collapse to '0'.
const KEPT = '990001';   // we hold values; Bllink disagrees
const EMPTY = '990002';  // we hold nothing
const NEW = '990003';    // not in the registry at all
const TEN_OWN = '990011';   // an owner name of ours, no tenant name
const TEN_KEPT = '990012';  // a tenant name of ours; Bllink disagrees
const TEN_NEW = '990013';   // not in the registry at all
const MAIL = '990021';      // an address of ours; Bllink disagrees
const FALLBACK = '990031';  // the resident list was unreachable for this run
const APTS = [KEPT, EMPTY, NEW, TEN_OWN, TEN_KEPT, TEN_NEW, MAIL, FALLBACK];

type Row = {
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  owner_email: string | null;
  tenant_email: string | null;
  owner_name_from_list: boolean;
  tenant_name_from_list: boolean;
};

const report = (over: Partial<Row> & { apartment_number: string }): Row =>
  ({
    owner_name: null, tenant_name: null, phone_owner: null, phone_tenant: null,
    owner_email: null, tenant_email: null,
    // The resident list is the source since 30/09/2026; a row that says
    // otherwise is the fallback case, which may fill but may not ask.
    owner_name_from_list: true, tenant_name_from_list: true, ...over,
  });

/** One raw report row, split exactly the way the sync splits it — the point of
 *  the tenant-name tests is that NOBODY writes a second parser. */
const fromCell = (apartment_number: string, cell: string): Row => {
  const names = splitOwnerTenantNames(cell);
  return report({ apartment_number, owner_name: names.owner, tenant_name: names.tenant });
};

async function contact(apt: string) {
  const r = await pool.query<{
    owner_name: string | null; owner_phone: string | null; owner_email: string | null;
    tenant_name: string | null; tenant_phone: string | null; tenant_email: string | null;
    source: string | null;
  }>(
    `select owner_name, owner_phone, owner_email, tenant_name, tenant_phone, tenant_email, source
       from public.contacts where apartment_number = $1`, [apt]);
  return r.rows[0] ?? null;
}

async function pendingOf(apt: string) {
  return (await getContactFieldState(apt)).suggestions;
}

async function cleanup() {
  // contact_sync_suggestions / contact_field_sources / apartment_owner_phones
  // all cascade from contacts.
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('the Bllink approval queue', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    await requireSeededAdmin(pool);
    await cleanup();
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, tenant_phone, source)
       values ($1, 'רונן משולם', '0541111111', null, 'manual'), ($2, null, null, null, 'manual')`,
      [KEPT, EMPTY]);
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('fills names we do not have, creates what we do not know, and asks about the rest — every phone included', async () => {
    const out = await syncContactsFromReport([
      // same name in a different spelling + a DIFFERENT phone + a tenant phone
      // we do not have at all
      report({ apartment_number: KEPT, owner_name: 'רונן  משולם ', phone_owner: '052-222-2222', phone_tenant: '0509999999' }),
      report({ apartment_number: EMPTY, owner_name: 'דנה', phone_owner: '0503333333' }),
      report({ apartment_number: NEW, owner_name: 'חדשה', phone_owner: '0504444444' }),
    ]);
    expect(out.created).toBe(1);
    expect(out.applied).toBe(1);   // EMPTY.owner_name only — no phone is written in
    // KEPT owner phone (conflict) + KEPT tenant phone + EMPTY owner phone +
    // NEW owner phone: a phone for an EMPTY field is a suggestion too.
    expect(out.suggested).toBe(4);

    // ours stands where it conflicts; an empty phone field STAYS empty
    expect(await contact(KEPT)).toMatchObject({
      owner_name: 'רונן משולם', owner_phone: '0541111111', tenant_phone: null,
    });
    expect(await contact(EMPTY)).toMatchObject({ owner_name: 'דנה', owner_phone: null });
    expect(await contact(NEW)).toMatchObject({ owner_name: 'חדשה', owner_phone: null, source: 'bllink_sync' });

    const open = await pendingOf(KEPT);
    expect(open.map((x) => x.field).sort()).toEqual(['owner_phone', 'tenant_phone']);
    expect(open.find((x) => x.field === 'owner_phone')).toMatchObject({
      current_value: '0541111111', proposed_value: '052-222-2222', access: true,
    });
    expect(open.find((x) => x.field === 'tenant_phone')).toMatchObject({
      current_value: null, proposed_value: '0509999999', access: true,
    });
    expect((await pendingOf(EMPTY)).map((x) => x.field)).toEqual(['owner_phone']);
    expect((await pendingOf(NEW)).map((x) => x.field)).toEqual(['owner_phone']);
  });

  it('records who wrote each field — a spelling change is not a change', async () => {
    const { sources } = await getContactFieldState(KEPT);
    // typed by hand before the sync, and the sync's identical name did not restamp it
    expect(sources.owner_name?.source).toBe('manual');
    expect(sources.owner_phone?.source).toBe('manual');
    // the empty phone field was NOT filled — nobody wrote it
    expect(sources.tenant_phone).toBeUndefined();
  });

  it('a second identical sync adds nothing and does not re-date the suggestion', async () => {
    const ownerPhone = async () => (await pendingOf(KEPT)).filter((x) => x.field === 'owner_phone');
    const before = (await ownerPhone())[0]!;
    const out = await syncContactsFromReport([
      report({ apartment_number: KEPT, owner_name: 'רונן משולם', phone_owner: '0522222222', phone_tenant: '050-999-9999' }),
    ]);
    expect(out).toMatchObject({ created: 0, applied: 0, suggested: 0 });
    const after = await ownerPhone();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.created_at).toEqual(before.created_at);
  });

  it('an empty value from Bllink changes nothing', async () => {
    const out = await syncContactsFromReport([report({ apartment_number: EMPTY })]);
    expect(out).toMatchObject({ applied: 0, suggested: 0 });
    expect(await contact(EMPTY)).toMatchObject({ owner_name: 'דנה', owner_phone: null });
    // …and the open phone question stays open
    expect((await pendingOf(EMPTY)).map((x) => x.field)).toEqual(['owner_phone']);
  });

  it('a rejected value does not come back — until Bllink changes it again', async () => {
    const ownerPhone = async () => (await pendingOf(KEPT)).filter((x) => x.field === 'owner_phone');
    const open = await ownerPhone();
    expect(await resolveSuggestions([open[0]!.id], 'reject', null)).toBe(1);
    // ours is untouched by a rejection
    expect((await contact(KEPT))?.owner_phone).toBe('0541111111');

    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '052-222-2222' })]);
    expect(await ownerPhone()).toHaveLength(0);

    // a THIRD value is a new question
    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '0587777777' })]);
    const again = await ownerPhone();
    expect(again).toHaveLength(1);
    expect(again[0]!.proposed_value).toBe('0587777777');
  });

  it('a suggestion our own edit satisfies closes itself', async () => {
    // the very same number, typed by hand in another spelling
    await pool.query(`update public.contacts set owner_phone = '058-777-7777' where apartment_number = $1`, [KEPT]);
    expect((await pendingOf(KEPT)).filter((x) => x.field === 'owner_phone')).toHaveLength(0);
    const row = await pool.query<{ status: string; resolved_by: string | null }>(
      `select status, resolved_by from public.contact_sync_suggestions
        where apartment_number = $1 and proposed_value = '0587777777'`, [KEPT]);
    expect(row.rows[0]).toMatchObject({ status: 'obsolete', resolved_by: null });
    // …and the hand edit is recorded as manual, over the sync's own stamp
    expect((await getContactFieldState(KEPT)).sources.owner_phone?.source).toBe('manual');
  });

  it('approving an owner phone lets that owner into the portal immediately', async () => {
    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '0526543210' })]);
    const open = (await pendingOf(KEPT)).filter((x) => x.field === 'owner_phone');
    expect(open).toHaveLength(1);

    // nobody is on the roster for that number yet
    expect(await findPortalRegistration('+972526543210', { onlyActive: true })).toBeNull();

    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(1);
    expect((await contact(KEPT))?.owner_phone).toBe('0526543210');

    // the roster trigger of 20260929162740 followed the write — no extra step
    const found = await findPortalRegistration('+972526543210', { onlyActive: true });
    expect(found?.apartmentNumbers).toEqual([KEPT]);
    // the value came from Bllink even though a person pressed the button
    expect((await getContactFieldState(KEPT)).sources.owner_phone?.source).toBe('bllink');
  });

  // ── the tenant's name (29/09/2026) ─────────────────────────────────────
  // Bllink always supplied it: the report's ONE name cell carries the owner
  // and the tenant, each tagged, and until now the tenant half was split off
  // and thrown away. It goes through the very same mechanism, with the very
  // same splitter — no second parser, and no new rule.

  it('a cell with only a tenant fills the tenant name and never touches the owner', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, source) values ($1, 'בעלים שלנו', 'manual')`,
      [TEN_OWN]);

    // The real shape of such a cell in the 29/09 report (apartment 814).
    const row = fromCell(TEN_OWN, 'טלי אראל (שוכר/ת)');
    expect(row).toMatchObject({ owner_name: null, tenant_name: 'טלי אראל' });

    const out = await syncContactsFromReport([row]);
    expect(out).toMatchObject({ applied: 1, suggested: 0 });
    // The owner is untouched — a tenant-only cell must never be read as one.
    expect(await contact(TEN_OWN)).toMatchObject({ owner_name: 'בעלים שלנו', tenant_name: 'טלי אראל' });
    // The owner's stamp is still the hand that typed it — the sync did not
    // touch that field, so it did not restamp it either.
    const state = await getContactFieldState(TEN_OWN);
    expect(state.sources.owner_name?.source).toBe('manual');
    expect(state.sources.tenant_name?.source).toBe('bllink');
  });

  it('the tenant name obeys the same seven rules as every other field', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, tenant_name, source)
       values ($1, 'תמנה כץ', 'צמרת אליקו', 'manual')`,
      [TEN_KEPT]);

    // (3) a new apartment is created from the report, both halves of the cell
    const created = await syncContactsFromReport([fromCell(TEN_NEW, 'בעלים חדש (בעלים) שוכר חדש (שוכר/ת)')]);
    expect(created.created).toBe(1);
    expect(await contact(TEN_NEW)).toMatchObject({ owner_name: 'בעלים חדש', tenant_name: 'שוכר חדש' });

    // (1) the same value in another spelling is not a change
    const same = await syncContactsFromReport([fromCell(TEN_KEPT, 'תמנה כץ (בעלים)  צמרת   אליקו  (שוכר/ת)')]);
    expect(same).toMatchObject({ applied: 0, suggested: 0 });

    // (4) a real difference is a question, and OURS STANDS
    const conflict = await syncContactsFromReport([fromCell(TEN_KEPT, 'תמנה כץ (בעלים) אליקו צמרת (שוכר/ת)')]);
    expect(conflict).toMatchObject({ applied: 0, suggested: 1 });
    expect((await contact(TEN_KEPT))?.tenant_name).toBe('צמרת אליקו');
    let open = (await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ current_value: 'צמרת אליקו', proposed_value: 'אליקו צמרת' });

    // (5) an empty cell changes nothing and does not withdraw the question
    await syncContactsFromReport([report({ apartment_number: TEN_KEPT })]);
    expect((await contact(TEN_KEPT))?.tenant_name).toBe('צמרת אליקו');
    expect((await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name')).toHaveLength(1);

    // (6) rejected — and it does not come back while Bllink says the same
    expect(await resolveSuggestions([open[0]!.id], 'reject', null)).toBe(1);
    await syncContactsFromReport([fromCell(TEN_KEPT, 'תמנה כץ (בעלים) אליקו צמרת (שוכר/ת)')]);
    expect((await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name')).toHaveLength(0);
    expect((await contact(TEN_KEPT))?.tenant_name).toBe('צמרת אליקו');

    // …a third value is a new question, and approving it writes ours
    await syncContactsFromReport([fromCell(TEN_KEPT, 'תמנה כץ (בעלים) חגית סימסולו רוזן (שוכר/ת)')]);
    open = (await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name');
    expect(open).toHaveLength(1);
    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(1);
    expect((await contact(TEN_KEPT))?.tenant_name).toBe('חגית סימסולו רוזן');
    expect((await getContactFieldState(TEN_KEPT)).sources.tenant_name?.source).toBe('bllink');

    // (7) an open question our own edit answers closes itself
    await syncContactsFromReport([fromCell(TEN_KEPT, 'תמנה כץ (בעלים) קטי (שוכר/ת)')]);
    expect((await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name')).toHaveLength(1);
    await pool.query(`update public.contacts set tenant_name = ' קטי ' where apartment_number = $1`, [TEN_KEPT]);
    expect((await pendingOf(TEN_KEPT)).filter((x) => x.field === 'tenant_name')).toHaveLength(0);
    expect((await getContactFieldState(TEN_KEPT)).sources.tenant_name?.source).toBe('manual');
  });

  // ── the addresses (29/09/2026) ─────────────────────────────────────────
  // Not from the debt export — it has none — but from Bllink's resident list,
  // which the scraper now reads on the same session (src/lib/sync/tenantList).
  // Once here they are just two more fields under the same seven rules.

  it('an address is filled where we have none, and asked about where we disagree', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_email, source)
       values ($1, 'uziyoeli@gmail.com', 'manual')`,
      [MAIL]);

    const out = await syncContactsFromReport([
      report({ apartment_number: MAIL, owner_email: 'eliyoeli@gmail.com', tenant_email: 'itamor@gmail.com' }),
    ]);
    expect(out).toMatchObject({ applied: 1, suggested: 1 });
    expect(await contact(MAIL)).toMatchObject({
      owner_email: 'uziyoeli@gmail.com',   // ours stands
      tenant_email: 'itamor@gmail.com',    // we had none
    });
    const open = (await pendingOf(MAIL)).filter((x) => x.field === 'owner_email');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ current_value: 'uziyoeli@gmail.com', proposed_value: 'eliyoeli@gmail.com' });
  });

  it('case, spacing and an invisible bidi mark are not a difference', async () => {
    // Apartment 1033 of the live registry holds an address with a trailing
    // U+202C. It reads identically to Bllink's and compared as different, so
    // the queue produced a suggestion approving which would change nothing.
    await pool.query(
      `update public.contacts set owner_email = $2 where apartment_number = $1`,
      [MAIL, ' Uzi.Yoeli@Gmail.com\u202c']);
    const out = await syncContactsFromReport([
      report({ apartment_number: MAIL, owner_email: 'uzi.yoeli@gmail.com' }),
    ]);
    expect(out).toMatchObject({ applied: 0, suggested: 0 });
  });

  it('approving an address writes it, and the card reads it from the registry', async () => {
    await pool.query(
      `update public.contacts set owner_email = 'old@example.com' where apartment_number = $1`, [MAIL]);
    await syncContactsFromReport([report({ apartment_number: MAIL, owner_email: 'new@example.com' })]);
    const open = (await pendingOf(MAIL)).filter((x) => x.field === 'owner_email');
    expect(open).toHaveLength(1);
    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(1);
    expect((await contact(MAIL))?.owner_email).toBe('new@example.com');
    expect((await getContactFieldState(MAIL)).sources.owner_email?.source).toBe('bllink');
  });

  // ── the resident list becomes the source of names (30/09/2026) ────────
  // Two new behaviours, both about the day the source changes underneath a
  // queue that is already full of the old source's questions.

  it('a name from the debt export fills an empty field but asks nothing', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, source)
       values ($1, 'כרמל ביץ אפרטמנטס- טלי אראל', 'manual')`, [FALLBACK]);

    // The resident list was unreachable, so the names came off the export's
    // labelled cell — the one that truncates. It disagrees with ours.
    const out = await syncContactsFromReport([
      report({
        apartment_number: FALLBACK,
        owner_name: "' אפרטמנטס- טלי אראל",
        tenant_name: 'שוכר מהדוח',
        owner_name_from_list: false,
        tenant_name_from_list: false,
      }),
    ]);
    // Ours stands and NOTHING is asked — that truncation is not a question.
    expect(out.suggested).toBe(0);
    expect((await pendingOf(FALLBACK))).toHaveLength(0);
    expect((await contact(FALLBACK))?.owner_name).toBe('כרמל ביץ אפרטמנטס- טלי אראל');
    // …but an EMPTY field is still worth filling from a second-best source.
    expect(out.applied).toBe(1);
    expect((await contact(FALLBACK))?.tenant_name).toBe('שוכר מהדוח');

    // The same value FROM THE LIST does ask.
    const asked = await syncContactsFromReport([
      report({ apartment_number: FALLBACK, owner_name: "' אפרטמנטס- טלי אראל" }),
    ]);
    expect(asked.suggested).toBe(1);
  });

  it('a suggestion the SOURCE withdraws closes itself, without anyone deciding', async () => {
    // It is open from the run above: the export proposed a truncated name.
    const open = (await pendingOf(FALLBACK)).filter((x) => x.field === 'owner_name');
    expect(open).toHaveLength(1);

    // Now the resident list says our name was right all along. Nobody should
    // have to reject a question nothing is asking any more.
    const out = await syncContactsFromReport([
      report({ apartment_number: FALLBACK, owner_name: 'כרמל ביץ אפרטמנטס- טלי אראל' }),
    ]);
    expect(out.closed).toBeGreaterThanOrEqual(1);
    expect(await pendingOf(FALLBACK)).toHaveLength(0);
    const row = await pool.query<{ status: string; resolved_by: string | null }>(
      `select status, resolved_by from public.contact_sync_suggestions
        where apartment_number = $1 and field = 'owner_name'
        order by created_at desc limit 1`, [FALLBACK]);
    expect(row.rows[0]).toMatchObject({ status: 'obsolete', resolved_by: null });
    // Ours was never written over — it was right.
    expect((await contact(FALLBACK))?.owner_name).toBe('כרמל ביץ אפרטמנטס- טלי אראל');
  });

  it('resolving the same id twice is a no-op, and the queue only ever lists open rows', async () => {
    await syncContactsFromReport([report({ apartment_number: KEPT, owner_name: 'שם אחר' })]);
    const open = (await pendingOf(KEPT)).filter((x) => x.field === 'owner_name');
    expect(open).toHaveLength(1);
    // a new owner NAME is a decision: a plain approve leaves it open…
    expect(open[0]).toMatchObject({ owner_change: true });
    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(0);
    // …"תיקון שם" decides it, once
    expect(await resolveSuggestions([open[0]!.id], 'approve_rename', null)).toBe(1);
    expect(await resolveSuggestions([open[0]!.id], 'approve_rename', null)).toBe(0);
    expect((await contact(KEPT))?.owner_name).toBe('שם אחר');

    const queue = await listPendingSuggestions();
    expect(queue.some((s) => s.id === open[0]!.id)).toBe(false);
    expect(queue.every((s) => !APTS.includes(s.apartment_number) || s.field.endsWith('_phone'))).toBe(true);
  });
});

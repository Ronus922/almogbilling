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
//   • an empty field of ours is filled with no approval;
//   • a CONFLICT becomes a suggestion and OURS STANDS;
//   • an empty value from Bllink changes nothing;
//   • two syncs in a row leave ONE suggestion, with its original date;
//   • a rejected value does not come back until Bllink changes it again;
//   • a suggestion our own edit satisfies closes itself;
//   • approving an owner phone puts that owner on the portal roster at once —
//     the promise of PR #50, now reachable from the approval queue too.
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
const { findOwnerIdentity } = await import('@/lib/db/portal/ownerPhones');

// Apartments this file creates. Removed by these exact strings (iron rule 12).
// Numeric on purpose: the registry keys on digits only
// (normalizeApartmentNumber), so a lettered fixture would collapse to '0'.
const KEPT = '990001';   // we hold values; Bllink disagrees
const EMPTY = '990002';  // we hold nothing
const NEW = '990003';    // not in the registry at all
const TEN_OWN = '990011';   // an owner name of ours, no tenant name
const TEN_KEPT = '990012';  // a tenant name of ours; Bllink disagrees
const TEN_NEW = '990013';   // not in the registry at all
const APTS = [KEPT, EMPTY, NEW, TEN_OWN, TEN_KEPT, TEN_NEW];

type Row = {
  apartment_number: string;
  owner_name: string | null;
  tenant_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
};

const report = (over: Partial<Row> & { apartment_number: string }): Row =>
  ({ owner_name: null, tenant_name: null, phone_owner: null, phone_tenant: null, ...over });

/** One raw report row, split exactly the way the sync splits it — the point of
 *  the tenant-name tests is that NOBODY writes a second parser. */
const fromCell = (apartment_number: string, cell: string): Row => {
  const names = splitOwnerTenantNames(cell);
  return { apartment_number, owner_name: names.owner, tenant_name: names.tenant, phone_owner: null, phone_tenant: null };
};

async function contact(apt: string) {
  const r = await pool.query<{
    owner_name: string | null; owner_phone: string | null;
    tenant_name: string | null; tenant_phone: string | null; source: string | null;
  }>(
    `select owner_name, owner_phone, tenant_name, tenant_phone, source
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

  it('fills what we do not have, creates what we do not know, and asks about the rest', async () => {
    const out = await syncContactsFromReport([
      // same name in a different spelling + a DIFFERENT phone + a tenant phone
      // we do not have at all
      report({ apartment_number: KEPT, owner_name: 'רונן  משולם ', phone_owner: '052-222-2222', phone_tenant: '0509999999' }),
      report({ apartment_number: EMPTY, owner_name: 'דנה', phone_owner: '0503333333' }),
      report({ apartment_number: NEW, owner_name: 'חדשה', phone_owner: '0504444444' }),
    ]);
    expect(out.created).toBe(1);
    expect(out.applied).toBe(3);   // KEPT.tenant_phone + both EMPTY fields
    expect(out.suggested).toBe(1); // only the owner phone conflicts

    // ours stands where it conflicts, and is filled where it was empty
    expect(await contact(KEPT)).toMatchObject({
      owner_name: 'רונן משולם', owner_phone: '0541111111', tenant_phone: '0509999999',
    });
    expect(await contact(EMPTY)).toMatchObject({ owner_name: 'דנה', owner_phone: '0503333333' });
    expect(await contact(NEW)).toMatchObject({ owner_name: 'חדשה', source: 'bllink_sync' });

    const open = await pendingOf(KEPT);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ field: 'owner_phone', current_value: '0541111111', proposed_value: '052-222-2222' });
  });

  it('records who wrote each field — a spelling change is not a change', async () => {
    const { sources } = await getContactFieldState(KEPT);
    // typed by hand before the sync, and the sync's identical name did not restamp it
    expect(sources.owner_name?.source).toBe('manual');
    expect(sources.owner_phone?.source).toBe('manual');
    // the empty field the sync filled
    expect(sources.tenant_phone?.source).toBe('bllink');
  });

  it('a second identical sync adds nothing and does not re-date the suggestion', async () => {
    const before = (await pendingOf(KEPT))[0]!;
    const out = await syncContactsFromReport([
      report({ apartment_number: KEPT, owner_name: 'רונן משולם', phone_owner: '0522222222', phone_tenant: '050-999-9999' }),
    ]);
    expect(out).toMatchObject({ created: 0, applied: 0, suggested: 0 });
    const after = await pendingOf(KEPT);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.created_at).toEqual(before.created_at);
  });

  it('an empty value from Bllink changes nothing', async () => {
    const out = await syncContactsFromReport([report({ apartment_number: EMPTY })]);
    expect(out).toMatchObject({ applied: 0, suggested: 0 });
    expect(await contact(EMPTY)).toMatchObject({ owner_name: 'דנה', owner_phone: '0503333333' });
  });

  it('a rejected value does not come back — until Bllink changes it again', async () => {
    const open = await pendingOf(KEPT);
    expect(await resolveSuggestions([open[0]!.id], 'reject', null)).toBe(1);
    // ours is untouched by a rejection
    expect((await contact(KEPT))?.owner_phone).toBe('0541111111');

    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '052-222-2222' })]);
    expect(await pendingOf(KEPT)).toHaveLength(0);

    // a THIRD value is a new question
    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '0587777777' })]);
    const again = await pendingOf(KEPT);
    expect(again).toHaveLength(1);
    expect(again[0]!.proposed_value).toBe('0587777777');
  });

  it('a suggestion our own edit satisfies closes itself', async () => {
    // the very same number, typed by hand in another spelling
    await pool.query(`update public.contacts set owner_phone = '058-777-7777' where apartment_number = $1`, [KEPT]);
    expect(await pendingOf(KEPT)).toHaveLength(0);
    const row = await pool.query<{ status: string; resolved_by: string | null }>(
      `select status, resolved_by from public.contact_sync_suggestions
        where apartment_number = $1 and proposed_value = '0587777777'`, [KEPT]);
    expect(row.rows[0]).toMatchObject({ status: 'obsolete', resolved_by: null });
    // …and the hand edit is recorded as manual, over the sync's own stamp
    expect((await getContactFieldState(KEPT)).sources.owner_phone?.source).toBe('manual');
  });

  it('approving an owner phone lets that owner into the portal immediately', async () => {
    await syncContactsFromReport([report({ apartment_number: KEPT, phone_owner: '0526543210' })]);
    const open = await pendingOf(KEPT);
    expect(open).toHaveLength(1);

    // nobody is on the roster for that number yet
    expect(await findOwnerIdentity('+972526543210', { onlyActive: true })).toBeNull();

    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(1);
    expect((await contact(KEPT))?.owner_phone).toBe('0526543210');

    // the roster trigger of 20260929162740 followed the write — no extra step
    const found = await findOwnerIdentity('+972526543210', { onlyActive: true });
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

  it('resolving the same id twice is a no-op, and the queue only ever lists open rows', async () => {
    await syncContactsFromReport([report({ apartment_number: KEPT, owner_name: 'שם אחר' })]);
    const open = await pendingOf(KEPT);
    expect(open).toHaveLength(1);
    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(1);
    expect(await resolveSuggestions([open[0]!.id], 'approve', null)).toBe(0);
    expect((await contact(KEPT))?.owner_name).toBe('שם אחר');

    const queue = await listPendingSuggestions();
    expect(queue.filter((s) => APTS.includes(s.apartment_number))).toHaveLength(0);
  });
});

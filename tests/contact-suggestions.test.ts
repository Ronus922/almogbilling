import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

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
const APTS = [KEPT, EMPTY, NEW];

type Row = {
  apartment_number: string;
  owner_name: string | null;
  phone_owner: string | null;
  phone_tenant: string | null;
};

const report = (over: Partial<Row> & { apartment_number: string }): Row =>
  ({ owner_name: null, phone_owner: null, phone_tenant: null, ...over });

async function contact(apt: string) {
  const r = await pool.query<{ owner_name: string | null; owner_phone: string | null; tenant_phone: string | null; source: string | null }>(
    `select owner_name, owner_phone, tenant_phone, source from public.contacts where apartment_number = $1`, [apt]);
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

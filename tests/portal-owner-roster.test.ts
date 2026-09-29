import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// ONE source of truth for owner phones (bug 29/09/2026, apartment 1233).
//
// The portal's OTP lookup reads public.apartment_owner_phones and nothing
// else. Until this migration that table was filled once, by the backfill of
// 27/09, and never again — so an owner added or corrected in "רשימת דיירים"
// afterwards was told "המספר אינו רשום" for ever. The triggers in
// 20260929162740_portal_owner_roster_follows_contacts make the roster FOLLOW
// contacts / contact_people, whatever writes them.
//
// What is pinned here:
//   • an owner entered by hand resolves through findOwnerIdentity IMMEDIATELY,
//     with no extra step, in every phone spelling an admin might type;
//   • the same for an additional owner on contact_people;
//   • a sync-shaped write (the ON CONFLICT upsert the Bllink import uses) does
//     not delete, deactivate or overwrite a hand-entered owner;
//   • is_active is never touched by a write to contacts — a deactivated owner
//     stays deactivated even when the nightly report re-supplies the number;
//   • the SQL normaliser and toPortalE164() agree on every fixture, which is
//     what keeps a row from being created that the login can never match.
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

const { findOwnerIdentity, isActiveOwner } = await import('@/lib/db/portal/ownerPhones');
const { toPortalE164 } = await import('@/lib/portal/phone');

/** Apartments this file creates. Removed by these exact strings (iron rule 12). */
const APT_MAIN = 'ROSTER-T1';
const APT_EXTRA = 'ROSTER-T2';
const APTS = [APT_MAIN, APT_EXTRA];

/** Numbers this file uses. Distinct from every seed number. */
const NAAMA = '+972523326911';
const MIKHA = '+972509123911';
const SOLD = '+972544502911';

async function cleanup() {
  await pool.query(`delete from public.apartment_owner_phones where apartment_number = any($1::text[])`, [APTS]);
  await pool.query(
    `delete from public.contact_people p using public.contacts c
      where p.contact_id = c.id and c.apartment_number = any($1::text[])`, [APTS]);
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('the roster follows the residents list', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    await requireSeededAdmin(pool);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('an owner typed into the residents list can sign in at once — in any spelling', async () => {
    // Exactly what the apartment card does: one INSERT into contacts.
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, source)
       values ($1, 'נעמה בדיקה', '052-332-6911', 'manual')`, [APT_MAIN]);

    const found = await findOwnerIdentity(NAAMA, { onlyActive: true });
    expect(found?.apartmentNumbers).toEqual([APT_MAIN]);
    expect(found?.ownerName).toBe('נעמה בדיקה');
    expect(await isActiveOwner(NAAMA)).toBe(true);

    // The three spellings an admin actually types all land on the one key —
    // the roster holds a single row, not three.
    for (const spelling of ['0523326911', '052-332-6911', '+972523326911', '972523326911']) {
      await pool.query(`update public.contacts set owner_phone = $2 where apartment_number = $1`, [APT_MAIN, spelling]);
      expect(toPortalE164(spelling)).toBe(NAAMA);
    }
    const rows = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.apartment_owner_phones
        where apartment_number = $1 and phone_e164 = $2`, [APT_MAIN, NAAMA]);
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('an ADDITIONAL owner on the card reaches the roster too', async () => {
    const c = await pool.query<{ id: string }>(
      `select id from public.contacts where apartment_number = $1`, [APT_MAIN]);
    await pool.query(
      `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
       values ($1, 'owner', 'מיכה בדיקה', '0509123911', true, 0)`, [c.rows[0]!.id]);

    const found = await findOwnerIdentity(MIKHA, { onlyActive: true });
    expect(found?.apartmentNumbers).toEqual([APT_MAIN]);
    expect(found?.ownerName).toBe('מיכה בדיקה');
  });

  it('a tenant phone still grants nothing', async () => {
    await pool.query(
      `update public.contacts set tenant_name = 'שוכר', tenant_phone = '0525550001' where apartment_number = $1`,
      [APT_MAIN]);
    expect(await findOwnerIdentity('+972525550001', { onlyActive: false })).toBeNull();
  });

  it('a landline or VoIP owner number is not put on the roster', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, source)
       values ($1, 'נייח', '04-8123456', 'manual')`, [APT_EXTRA]);
    const rows = await pool.query(
      `select 1 from public.apartment_owner_phones where apartment_number = $1`, [APT_EXTRA]);
    expect(rows.rowCount).toBe(0);
    // 072 is ten digits exactly like a mobile — a length test would let it in.
    await pool.query(`update public.contacts set owner_phone = '0722592624' where apartment_number = $1`, [APT_EXTRA]);
    const rows2 = await pool.query(
      `select 1 from public.apartment_owner_phones where apartment_number = $1`, [APT_EXTRA]);
    expect(rows2.rowCount).toBe(0);
  });

  it('a sync-shaped write neither deletes nor deactivates a hand-entered owner', async () => {
    // A deliberate revocation an admin made on the "בעלי דירה" tab.
    await pool.query(
      `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164, is_active)
       values ($1, 'בעלים קודם', $2, false)`, [APT_MAIN, SOLD]);

    // …and the nightly report, re-supplying that very number as the owner.
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, source, needs_review)
       values ($1, 'בעלים קודם', '0544502911', 'bllink_sync', true)
       on conflict (apartment_number) do update
         set owner_name  = coalesce(excluded.owner_name,  public.contacts.owner_name),
             owner_phone = coalesce(excluded.owner_phone, public.contacts.owner_phone)`,
      [APT_MAIN]);

    // The revocation holds: the sync may not hand access back.
    const sold = await pool.query<{ is_active: boolean }>(
      `select is_active from public.apartment_owner_phones where apartment_number = $1 and phone_e164 = $2`,
      [APT_MAIN, SOLD]);
    expect(sold.rows[0]!.is_active).toBe(false);
    expect(await isActiveOwner(SOLD)).toBe(false);

    // And the two hand-entered owners are untouched — still there, still on.
    for (const phone of [NAAMA, MIKHA]) {
      const row = await pool.query<{ is_active: boolean }>(
        `select is_active from public.apartment_owner_phones where apartment_number = $1 and phone_e164 = $2`,
        [APT_MAIN, phone]);
      expect(row.rowCount).toBe(1);
      expect(row.rows[0]!.is_active).toBe(true);
    }
  });

  it('removing an owner from the card does not silently revoke portal access', async () => {
    // Additive only: access is revoked on the "בעלי דירה" tab, deliberately,
    // never as a side effect of editing the residents list.
    await pool.query(
      `delete from public.contact_people p using public.contacts c
        where p.contact_id = c.id and c.apartment_number = $1 and p.phone = '0509123911'`, [APT_MAIN]);
    expect(await isActiveOwner(MIKHA)).toBe(true);
  });

  it('the SQL normaliser and toPortalE164() agree on every fixture', async () => {
    // The trigger cannot call the TypeScript rule, so there are two copies of
    // it. This is what stops them drifting: disagree and a row exists that the
    // login can never match, or an owner is refused a row they should have.
    const fixtures = [
      '0541234567', '054-123-4567', '  0541234567 ', '972541234567', '+972541234567',
      '00972541234567', '541234567', '0501234567/0521234567', '0501234567, 0521234567',
      '04-8123456', '0722592624', '+972722592624', '025555555', '+14155552671',
      '+1 (415) 555-2671', '14155552671', '+0541234567', '', '   ', 'לא טלפון',
      '05412345', '05412345678', '+9725412345', '+972541234567890',
    ];
    const res = await pool.query<{ i: number; sql: string | null }>(
      `select i, public.portal_owner_e164(v) as sql from unnest($1::text[]) with ordinality as t(v, i)`,
      [fixtures]);
    for (const row of res.rows) {
      const raw = fixtures[row.i - 1]!;
      expect({ raw, out: row.sql }).toEqual({ raw, out: toPortalE164(raw) });
    }
  });
});

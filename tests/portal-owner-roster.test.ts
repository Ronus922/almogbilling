import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// ONE source of truth for owner phones — the roster MIRRORS the owner records.
//
// The portal's OTP lookup reads public.apartment_owner_phones and nothing
// else. 20260929162740 made it follow contacts / contact_people, but ADD-ONLY:
// a phone removed from the card or replaced kept its row for ever, which is how
// a phone came to open apartments it does not own (audit 03/10/2026). Since
// 20261003095149 the roster is recomputed from the owner records at COMMIT, in
// both directions, by deferred triggers.
//
// What is pinned here:
//   • the iron rule: a phone is linked ONLY through an explicit owner record of
//     that apartment (contacts.owner_phone or a contact_people owner) — a
//     tenant, a stray row, a landline: nothing;
//   • every spelling (05x / +972 / 972) lands on the one key — one row;
//   • removing a person, replacing a phone, replacing the owner → the old row
//     is switched off in the SAME transaction (a rollback leaves it on);
//   • a card save that moves a phone between the owner field and the people
//     list, in one transaction, never switches it off in between;
//   • a Bllink approval that replaces the owner detaches the previous owner's
//     phone in the same call, even while the owner field still holds it;
//   • a detach is sticky while the record holds the phone, and released when
//     the phone leaves the record — typed in again, it links again;
//   • every link change is in audit_log;
//   • the SQL normaliser and toPortalE164() agree on every fixture, including
//     the NBSP / tab spellings the audit found.
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

const { detachOwnerPhone, isActiveOwner } = await import('@/lib/db/portal/ownerPhones');
const { findPortalRegistration, resolvePortalIdentity } = await import('@/lib/db/portal/identity');
const { toPortalE164 } = await import('@/lib/portal/phone');

/** Apartments this file creates. Removed by these exact strings (iron rule 12). */
const APT_MAIN = 'ROSTER-T1';
const APT_EXTRA = 'ROSTER-T2';
const APT_SALE = 'ROSTER-T3';
const APTS = [APT_MAIN, APT_EXTRA, APT_SALE];

/** Numbers this file uses. Distinct from every seed number. */
const NAAMA = '+972523326911';
const MIKHA = '+972509123911';
const STRAY = '+972544502911';
const NEWP = '+972544502912';
const OLD_OWNER = '+972544502913';
const NEW_OWNER = '+972544502914';

let adminId = '';

async function rosterRow(apartment: string, phone: string) {
  const r = await pool.query<{
    id: string; is_active: boolean; owner_name: string | null;
    source_table: string | null; detached_at: string | null; detach_reason: string | null;
  }>(
    `select id, is_active, owner_name, source_table, detached_at::text as detached_at, detach_reason
       from public.apartment_owner_phones where apartment_number = $1 and phone_e164 = $2`,
    [apartment, phone]);
  return r.rows[0] ?? null;
}

async function auditActions(rosterId: string): Promise<string[]> {
  const r = await pool.query<{ action: string }>(
    `select action || ':' || coalesce(metadata->>'reason', '') as action from public.audit_log
      where entity_type = 'apartment_owner_phone' and entity_id = $1 order by created_at, id`,
    [rosterId]);
  return r.rows.map((x) => x.action);
}

async function contactId(apartment: string): Promise<string> {
  const c = await pool.query<{ id: string }>(`select id from public.contacts where apartment_number = $1`, [apartment]);
  return c.rows[0]!.id;
}

/** Suggestions this file creates — removed by id. */
const suggestionIds: string[] = [];

async function cleanup() {
  // The audit rows of the roster rows these apartments hold — by those exact ids.
  await pool.query(
    `delete from public.audit_log
      where entity_type = 'apartment_owner_phone'
        and entity_id in (select id::text from public.apartment_owner_phones
                           where apartment_number = any($1::text[]))`, [APTS]);
  if (suggestionIds.length) {
    await pool.query(`delete from public.contact_sync_suggestions where id = any($1::uuid[])`, [suggestionIds]);
  }
  await pool.query(`delete from public.contact_field_sources where apartment_number = any($1::text[])`, [APTS]);
  await pool.query(`delete from public.apartment_owner_phones where apartment_number = any($1::text[])`, [APTS]);
  await pool.query(
    `delete from public.contact_people p using public.contacts c
      where p.contact_id = c.id and c.apartment_number = any($1::text[])`, [APTS]);
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('the roster follows the residents list', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    adminId = await requireSeededAdmin(pool);
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

    const found = await resolvePortalIdentity(NAAMA);
    expect(found?.apartments.map((a) => [a.apartmentNumber, a.role])).toEqual([[APT_MAIN, 'owner']]);
    expect(found?.name).toBe('נעמה בדיקה');
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

    const found = await resolvePortalIdentity(MIKHA);
    expect(found?.apartments.map((a) => a.apartmentNumber)).toEqual([APT_MAIN]);
    expect(found?.name).toBe('מיכה בדיקה');
  });

  it('a tenant phone the card HIDES (resident type "owner") grants nothing', async () => {
    await pool.query(
      `update public.contacts set tenant_name = 'שוכר', tenant_phone = '0525550001' where apartment_number = $1`,
      [APT_MAIN]);
    expect(await findPortalRegistration('+972525550001', { onlyActive: false })).toBeNull();
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

  it('the same phone in the owner field AND as an additional owner is still ONE link — 05x and +972 alike', async () => {
    const c = await contactId(APT_MAIN);
    await pool.query(
      `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
       values ($1, 'owner', 'נעמה בדיקה', '+972523326911', true, 1)`, [c]);
    const rows = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.apartment_owner_phones
        where apartment_number = $1 and phone_e164 = $2`, [APT_MAIN, NAAMA]);
    expect(rows.rows[0]!.n).toBe('1');
    // The owner field wins as the record of provenance.
    expect((await rosterRow(APT_MAIN, NAAMA))?.source_table).toBe('contacts');
    await pool.query(`delete from public.contact_people where contact_id = $1 and phone = '+972523326911'`, [c]);
    expect((await rosterRow(APT_MAIN, NAAMA))?.is_active).toBe(true);
  });

  it('a phone no owner record carries is switched off the next time the apartment is written — logged', async () => {
    // A stray row exactly like the 40 the audit found: no record holds it.
    await pool.query(
      `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164)
       values ($1, 'שארית', $2)`, [APT_MAIN, STRAY]);
    expect(await isActiveOwner(STRAY)).toBe(true);

    await pool.query(`update public.contacts set owner_name = owner_name where apartment_number = $1`, [APT_MAIN]);

    const row = await rosterRow(APT_MAIN, STRAY);
    expect(row?.is_active).toBe(false);
    expect(row?.source_table).toBeNull();
    expect(await isActiveOwner(STRAY)).toBe(false);
    expect(await auditActions(row!.id)).toEqual(['portal_owner_phone_deactivated:source_removed']);
    // The real owners are untouched.
    expect((await rosterRow(APT_MAIN, NAAMA))?.is_active).toBe(true);
    expect((await rosterRow(APT_MAIN, MIKHA))?.is_active).toBe(true);
  });

  it('removing an owner from the card switches the phone off in the SAME transaction', async () => {
    const c = await contactId(APT_MAIN);
    const client = await pool.connect();
    try {
      // Rolled back: nothing happened, the phone is still in.
      await client.query('BEGIN');
      await client.query(`delete from public.contact_people where contact_id = $1 and phone = '0509123911'`, [c]);
      await client.query('ROLLBACK');
      expect(await isActiveOwner(MIKHA)).toBe(true);

      // Committed: the record and the roster change together.
      await client.query('BEGIN');
      await client.query(`delete from public.contact_people where contact_id = $1 and phone = '0509123911'`, [c]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await isActiveOwner(MIKHA)).toBe(false);
    const row = await rosterRow(APT_MAIN, MIKHA);
    expect(await auditActions(row!.id)).toEqual([
      'portal_owner_phone_linked:', 'portal_owner_phone_deactivated:source_removed',
    ]);

    // Typed in again → linked again.
    await pool.query(
      `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
       values ($1, 'owner', 'מיכה בדיקה', '050-912-3911', true, 0)`, [c]);
    expect(await isActiveOwner(MIKHA)).toBe(true);
  });

  it('a card save that moves a phone from the owner field to the people list, in one transaction, never drops it', async () => {
    const c = await contactId(APT_MAIN);
    const row = await rosterRow(APT_MAIN, NAAMA);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`update public.contacts set owner_phone = null where id = $1`, [c]);
      await client.query(
        `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
         values ($1, 'owner', 'נעמה בדיקה', '0523326911', true, 2)`, [c]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = await rosterRow(APT_MAIN, NAAMA);
    expect(after?.is_active).toBe(true);
    expect(after?.source_table).toBe('contact_people');
    expect((await auditActions(row!.id)).filter((a) => a.startsWith('portal_owner_phone_deactivated'))).toEqual([]);
    // Back into the owner field for the tests below.
    await pool.query(`update public.contacts set owner_phone = '0523326911' where id = $1`, [c]);
    await pool.query(`delete from public.contact_people where contact_id = $1 and phone = '0523326911'`, [c]);
  });

  it('replacing the phone switches the old one off and links the new one', async () => {
    await pool.query(`update public.contacts set owner_phone = '0544502912' where apartment_number = $1`, [APT_MAIN]);
    expect((await rosterRow(APT_MAIN, NAAMA))?.is_active).toBe(false);
    const fresh = await rosterRow(APT_MAIN, NEWP);
    expect(fresh?.is_active).toBe(true);
    expect(fresh?.owner_name).toBe('נעמה בדיקה');
    expect(fresh?.source_table).toBe('contacts');
  });

  it('replacing the owner on the card (name and phone) leaves the previous owner nothing', async () => {
    await pool.query(
      `update public.contacts set owner_name = 'בעלים חדש', owner_phone = '0523326911' where apartment_number = $1`,
      [APT_MAIN]);
    expect((await rosterRow(APT_MAIN, NEWP))?.is_active).toBe(false);
    // The phone that came back is linked again, under the name ON its record.
    const back = await rosterRow(APT_MAIN, NAAMA);
    expect(back?.is_active).toBe(true);
    expect(back?.owner_name).toBe('בעלים חדש');
  });

  it('a Bllink approval that replaces the owner detaches the previous owner — though the owner field still holds the phone', async () => {
    await pool.query(
      `insert into public.contacts (apartment_number, owner_name, owner_phone, source)
       values ($1, 'בעלים ישן', '0544502913', 'manual')`, [APT_SALE]);
    expect(await isActiveOwner(OLD_OWNER)).toBe(true);

    const sug = await pool.query<{ id: string }>(
      `insert into public.contact_sync_suggestions (apartment_number, field, current_value, proposed_value, source)
       values ($1, 'owner_name', 'בעלים ישן', 'בעלים חדש', 'bllink') returning id`, [APT_SALE]);
    suggestionIds.push(sug.rows[0]!.id);
    // A plain approve does not decide a new owner name — it stays open…
    const plain = await pool.query<{ n: number }>(
      `select public.contact_suggestion_resolve($1::uuid[], 'approve', $2) as n`, [[sug.rows[0]!.id], adminId]);
    expect(plain.rows[0]!.n).toBe(0);
    // …"החלפת בעלים" does.
    await pool.query(`select public.contact_suggestion_resolve($1::uuid[], 'approve_replace', $2)`, [[sug.rows[0]!.id], adminId]);

    const contact = await pool.query<{ owner_name: string; owner_phone: string }>(
      `select owner_name, owner_phone from public.contacts where apartment_number = $1`, [APT_SALE]);
    expect(contact.rows[0]).toEqual({ owner_name: 'בעלים חדש', owner_phone: '0544502913' });

    const row = await rosterRow(APT_SALE, OLD_OWNER);
    expect(row?.is_active).toBe(false);
    expect(row?.detach_reason).toBe('owner_replaced');
    expect(await isActiveOwner(OLD_OWNER)).toBe(false);
    expect(await auditActions(row!.id)).toContain('portal_owner_phone_detached:owner_replaced');

    // Sticky: saving the apartment again does not hand access back…
    await pool.query(`update public.contacts set owner_name = owner_name where apartment_number = $1`, [APT_SALE]);
    expect((await rosterRow(APT_SALE, OLD_OWNER))?.is_active).toBe(false);

    // …the phone leaving the record releases the detach…
    await pool.query(`update public.contacts set owner_phone = null where apartment_number = $1`, [APT_SALE]);
    const released = await rosterRow(APT_SALE, OLD_OWNER);
    expect(released?.detached_at).toBeNull();
    expect(released?.is_active).toBe(false);

    // …and typed in again it links again — the one way back.
    await pool.query(`update public.contacts set owner_phone = '0544502913' where apartment_number = $1`, [APT_SALE]);
    expect((await rosterRow(APT_SALE, OLD_OWNER))?.is_active).toBe(true);
  });

  it('"החלפת בעלים" takes the new owner phone along: previous phone off, the new one on under the new name', async () => {
    const ids = await pool.query<{ id: string }>(
      `insert into public.contact_sync_suggestions (apartment_number, field, current_value, proposed_value, source)
       values ($1, 'owner_name', 'בעלים חדש', 'קונה שלישי', 'bllink'),
              ($1, 'owner_phone', '0544502913', '0544502914', 'bllink')
       returning id`, [APT_SALE]);
    const list = ids.rows.map((r) => r.id);
    suggestionIds.push(...list);
    // The phone waits for the owner-name decision…
    const early = await pool.query<{ n: number }>(
      `select public.contact_suggestion_resolve($1::uuid[], 'approve', $2) as n`, [[list[1]], adminId]);
    expect(early.rows[0]!.n).toBe(0);
    // …and the replacement, given the NAME suggestion only, approves both.
    const n = await pool.query<{ n: number }>(
      `select public.contact_suggestion_resolve($1::uuid[], 'approve_replace', $2) as n`, [[list[0]], adminId]);
    expect(n.rows[0]!.n).toBe(2);

    expect((await rosterRow(APT_SALE, OLD_OWNER))?.is_active).toBe(false);
    const fresh = await rosterRow(APT_SALE, NEW_OWNER);
    expect(fresh?.is_active).toBe(true);
    expect(fresh?.owner_name).toBe('קונה שלישי');
    expect(await isActiveOwner(NEW_OWNER)).toBe(true);
  });

  it('an admin detach is sticky while the record holds the phone', async () => {
    const row = await rosterRow(APT_SALE, NEW_OWNER);
    const detached = await detachOwnerPhone(APT_SALE, row!.id, adminId);
    expect(detached?.phone_e164).toBe(NEW_OWNER);
    expect(await isActiveOwner(NEW_OWNER)).toBe(false);
    // An id from another apartment is not reachable through this apartment.
    expect(await detachOwnerPhone(APT_MAIN, row!.id, adminId)).toBeNull();

    await pool.query(`update public.contacts set owner_name = owner_name where apartment_number = $1`, [APT_SALE]);
    const after = await rosterRow(APT_SALE, NEW_OWNER);
    expect(after?.is_active).toBe(false);
    expect(after?.detach_reason).toBe('admin');
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
      // The audit's one divergence: whitespace String.trim() strips and btrim() did not.
      '\u00a0+14155552671', '\t0541234567\u00a0', '\u202f+447911123456\u3000', '\ufeff+972541234567',
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

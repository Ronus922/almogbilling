import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';
import { extractTenantPeople } from '@/lib/sync/tenantList';

// Bllink "ניתוק" decided by PHONE, not by name (migration 20261003191659,
// 03/10/2026) — against a throwaway database (WA_TEST_DATABASE_URL), through
// the real SQL. Fixtures are made here and removed by their exact apartments /
// ids (iron rule 12); the phones below exist nowhere else.
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

const { listSuggestionsForApartment, suggestPortalLinks } = await import('@/lib/db/contactSuggestions');

const A = {
  renamed: '990801', gone: '990802', inactive: '990803', formats: '990804',
  byName: '990805', otherName: '990806', stale: '990807', extra: '990808',
};
const APTS = Object.values(A);
const P = {
  renamed: '0527700801', gone: '0527700802', goneNew: '0527700812', inactive: '0527700803',
  f9: '0527700804', fIntl: '0527700814', fDash: '0527700824',
  byName: '0527700805', otherName: '0527700806', stale: '0527700807', extra: '0527700808',
};
const e164 = (local: string) => `+972${local.slice(1)}`;

const made = { scrapes: [] as string[] };

async function card(apt: string, cols: Record<string, string | null>) {
  const keys = Object.keys(cols);
  await pool.query(
    `insert into public.contacts (apartment_number, source, ${keys.join(', ')})
     values ($1, 'manual', ${keys.map((_, i) => `$${i + 2}`).join(', ')})`,
    [apt, ...keys.map((k) => cols[k])],
  );
}
type Raw = { name?: string | null; phone?: string | null; role?: 'owner' | 'renter'; active?: boolean; primary?: boolean };
/** One scrape whose list holds exactly these people, through the real parser. */
async function scrape(byApt: Record<string, Raw[]>): Promise<string> {
  const people = extractTenantPeople({
    apartments: Object.entries(byApt).map(([apartmentNum, list]) => ({
      apartmentNum,
      tenants: list.map((p) => ({
        tenant: { isActive: p.active ?? true, isPrimary: p.primary ?? false },
        details: { tenantType: p.role ?? 'owner', name: p.name ?? null, phone: p.phone ?? null },
      })),
    })),
  });
  const r = await pool.query<{ id: string }>(
    `insert into public.bllink_scrapes (status, tenant_list_ok, list_people) values ('success', true, $1::jsonb) returning id`,
    [JSON.stringify(people)],
  );
  made.scrapes.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}
async function open(apt: string) {
  return (await listSuggestionsForApartment(apt)).map((s) => ({
    field: s.field, phone: s.phone_e164, reason: s.unlink_reason, from: s.current_value, to: s.proposed_value,
    owner_change: s.owner_change,
  }));
}
async function cleanup() {
  for (const id of made.scrapes) await pool.query(`delete from public.bllink_scrapes where id = $1`, [id]);
  // roster, contact_people and suggestions cascade from contacts
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('Bllink "ניתוק" by phone (20261003191659)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    await requireSeededAdmin(pool);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('the same phone under another name → a name suggestion only, never "ניתוק"', async () => {
    await card(A.renamed, { owner_name: 'דוד כהן', owner_phone: P.renamed });
    const id = await scrape({ [A.renamed]: [{ name: 'David Cohen', phone: P.renamed, primary: true }] });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 0, suggested_link: 0, suggested_name: 1 });
    // an owner-name CHANGE → decided as "תיקון שם" / "החלפת בעלים", never a plain approve
    expect(await open(A.renamed)).toEqual([
      { field: 'owner_name', phone: null, reason: null, from: 'דוד כהן', to: 'David Cohen', owner_change: true },
    ]);
    // the next run does not raise it twice
    const again = await scrape({ [A.renamed]: [{ name: 'David Cohen', phone: P.renamed, primary: true }] });
    expect(await suggestPortalLinks(again)).toMatchObject({ suggested_unlink: 0, suggested_name: 0 });
  });

  it('a phone Bllink does not list in the apartment → "ניתוק", reason phone_not_listed', async () => {
    await card(A.gone, { owner_name: 'בעלים קודם', owner_phone: P.gone });
    const id = await scrape({ [A.gone]: [{ name: 'בעלים חדש', phone: P.goneNew, primary: true }] });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 1, suggested_link: 1 });
    expect((await open(A.gone)).find((s) => s.field === 'portal_unlink'))
      .toMatchObject({ phone: e164(P.gone), reason: 'phone_not_listed' });
  });

  it('a phone listed with isActive = false → "ניתוק", reason inactive — whatever the name', async () => {
    await card(A.inactive, { owner_name: 'עזב', owner_phone: P.inactive });
    const id = await scrape({ [A.inactive]: [
      { name: 'עזב', phone: P.inactive, active: false },
      { name: 'עזב', phone: null },              // the phone wins over a phoneless namesake
    ] });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 1 });
    expect((await open(A.inactive)).find((s) => s.field === 'portal_unlink'))
      .toMatchObject({ phone: e164(P.inactive), reason: 'inactive' });
  });

  it('05x, +972 and Bllink\'s 9-digit form all match the same link', async () => {
    await card(A.formats, { owner_name: 'שלושה טלפונים', owner_phone: P.f9 });
    await pool.query(`insert into public.contact_people (contact_id, role, name, phone)
      select id, 'owner', 'שלושה טלפונים', unnest($2::text[]) from public.contacts where apartment_number = $1`,
    [A.formats, [P.fIntl, P.fDash]]);
    const id = await scrape({ [A.formats]: [
      { name: 'שלושה טלפונים', phone: P.f9.slice(1) },                          // 527700804
      { name: 'שלושה טלפונים', phone: `+972-${P.fIntl.slice(1, 3)}-${P.fIntl.slice(3)}` },
      { name: 'שלושה טלפונים', phone: `${P.fDash.slice(0, 3)}-${P.fDash.slice(3)}` },
    ] });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 0, suggested_link: 0 });
    expect(await open(A.formats)).toEqual([]);
  });

  it('no usable phone in Bllink → matched by name; another name → "ניתוק"', async () => {
    await card(A.byName, { owner_name: 'רחל  לוי', owner_phone: P.byName });
    await card(A.otherName, { owner_name: 'משה ישראלי', owner_phone: P.otherName });
    const id = await scrape({
      [A.byName]: [{ name: 'רחל לוי', phone: '000000000' }],          // junk zeros = no phone
      [A.otherName]: [{ name: 'מישהו אחר', phone: null }],
    });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 1 });
    expect(await open(A.byName)).toEqual([]);
    expect((await open(A.otherName)).find((s) => s.field === 'portal_unlink'))
      .toMatchObject({ phone: e164(P.otherName), reason: 'phone_not_listed' });
  });

  it('an open "ניתוק" the rule no longer supports is closed (obsolete, not deleted) and logged', async () => {
    const since = (await pool.query<{ t: string }>(`select clock_timestamp()::text as t`)).rows[0]!.t;
    await card(A.stale, { owner_name: 'כתיב אחד', owner_phone: P.stale });
    // raised by the name-blind rule before this migration (no reason)
    const old = await pool.query<{ id: string }>(
      `insert into public.contact_sync_suggestions
         (apartment_number, field, current_value, proposed_value, source, phone_e164, person_role, person_name)
       values ($1, 'portal_unlink', 'כתיב אחד', $2, 'bllink', $2, 'owner', 'כתיב אחד') returning id`,
      [A.stale, e164(P.stale)]);
    const id = await scrape({ [A.stale]: [{ name: 'כתיב שני', phone: P.stale, primary: true }] });
    const out = await suggestPortalLinks(id);
    expect(out.suggested_unlink).toBe(0);
    expect(out.closed).toBeGreaterThanOrEqual(1);
    const row = await pool.query(`select status, resolved_at is not null as resolved from public.contact_sync_suggestions where id = $1`,
      [old.rows[0]!.id]);
    expect(row.rows[0]).toEqual({ status: 'obsolete', resolved: true });
    const audit = await pool.query(
      `select metadata->>'reason' as reason, metadata->>'field' as field from public.audit_log
        where action = 'contact_suggestion_closed' and entity_id = $1 and created_at >= $2::timestamptz`,
      [old.rows[0]!.id, since]);
    expect(audit.rows).toEqual([{ reason: 'bllink_lists_phone', field: 'portal_unlink' }]);
  });

  it('a phone that is not on the card field (an extra owner) under another name → no "ניתוק", no name suggestion', async () => {
    await card(A.extra, { owner_name: 'בעלים ראשי', owner_phone: null });
    await pool.query(`insert into public.contact_people (contact_id, role, name, phone)
      select id, 'owner', 'בעלים נוסף', $2 from public.contacts where apartment_number = $1`, [A.extra, P.extra]);
    const id = await scrape({ [A.extra]: [
      { name: 'בעלים ראשי', phone: null, primary: true },
      { name: 'Other Spelling', phone: P.extra },
    ] });
    expect(await suggestPortalLinks(id)).toMatchObject({ suggested_unlink: 0, suggested_name: 0 });
    expect((await open(A.extra)).filter((s) => s.field === 'portal_unlink' || s.field === 'owner_name')).toEqual([]);
  });
});

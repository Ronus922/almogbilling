import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';

// The entry warning ("אותו אדם?") on EVERY write of a resident phone, not only
// the apartment card (03/10/2026): the debtor panel's phone edit, the Bllink
// queue's approvals and the file imports — through the real routes, the real
// SQL and one shared helper (lib/http/phoneEntry.ts). Against a throwaway
// database (WA_TEST_DATABASE_URL); fixtures removed by their exact apartments
// and ids (iron rule 12); the phones exist nowhere else.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = describe.skipIf(!TEST_URL);

let pool: Pool;
const h = vi.hoisted(() => ({
  actor: null as null | { id: string; username: string; email: string; full_name: string | null; role: string },
}));

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
vi.mock('@/lib/auth/actor', async () => {
  const { AuthorizationError } = await import('@/lib/auth/errors');
  const guard = vi.fn(async () => {
    if (!h.actor) throw new AuthorizationError('אין הרשאה לבצע את הפעולה');
    return { ...h.actor, permissions: [], isAuthenticated: true as const };
  });
  return { requirePermission: guard, requireAnyPermission: guard };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

const debtorRoute = await import('@/app/api/debtors/[id]/route');
const suggestionsRoute = await import('@/app/api/contacts/suggestions/route');
const { upsertContactAndLinkDebtor } = await import('@/lib/db/contacts');
const { PhoneEntryConflictError } = await import('@/lib/db/portal/identityApprovals');

const A = { first: '990901', panel: '990902', queue: '990903', imported: '990904' };
const APTS = Object.values(A);
const PHONE = '0527700901';
const E164 = '+972527700901';
const made = { debtors: [] as string[] };

async function card(apt: string, cols: Record<string, string | null>) {
  const keys = Object.keys(cols);
  const r = await pool.query<{ id: string }>(
    `insert into public.contacts (apartment_number, source, ${keys.join(', ')})
     values ($1, 'manual', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
    [apt, ...keys.map((k) => cols[k])],
  );
  return r.rows[0]!.id;
}
const ownerPhone = async (apt: string) => (await pool.query<{ owner_phone: string | null }>(
  `select owner_phone from public.contacts where apartment_number = $1`, [apt])).rows[0]?.owner_phone ?? null;

async function cleanup() {
  for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
  await pool.query(`delete from public.portal_phone_entry_flags where phone_e164 = $1`, [E164]);
  await pool.query(`delete from public.portal_identity_approvals where phone_e164 = $1`, [E164]);
  // roster, contact_people and suggestions cascade from contacts
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('the entry warning on every phone write (03/10/2026)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    const adminId = await requireSeededAdmin(pool);
    // a manager without portal_manage: "כן" would only request — "לא" is what we answer here
    h.actor = { id: adminId, username: 'e2e-admin', email: 'e2e@t', full_name: 'בודק', role: 'manager' };
    await cleanup();
    // the phone is registered at A.first under one name
    await card(A.first, { owner_name: 'ראשון בדיקה', owner_phone: PHONE });
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('the debtor panel: a phone registered elsewhere under another name → 409 "אותו אדם?", nothing saved; "לא" → saved and flagged', async () => {
    const contactId = await card(A.panel, { owner_name: 'שני בדיקה' });
    const debtor = await pool.query<{ id: string }>(
      `insert into public.debtors (apartment_number, owner_name, contact_id) values ($1, 'שני בדיקה', $2) returning id`,
      [A.panel, contactId]);
    const debtorId = debtor.rows[0]!.id;
    made.debtors.push(debtorId);
    const patch = (body: unknown) => debtorRoute.PATCH(
      new Request(`http://t/api/debtors/${debtorId}`, { method: 'PATCH', body: JSON.stringify(body) }) as never,
      { params: Promise.resolve({ id: debtorId }) },
    );

    const asked = await patch({ phone_owner: PHONE, notes: 'לא נשמר' });
    expect(asked.status).toBe(409);
    const body = await asked.json();
    expect(body).toMatchObject({ error: 'phone_conflict', can_approve: false });
    expect(body.conflicts).toEqual([expect.objectContaining({
      phone_e164: E164, apartment_number: A.panel, entered_name: 'שני בדיקה',
      others: [expect.objectContaining({ apartment_number: A.first, name: 'ראשון בדיקה' })],
    })]);
    expect(await ownerPhone(A.panel)).toBeNull();
    const notes = await pool.query(`select notes from public.debtors where id = $1`, [debtorId]);
    expect(notes.rows[0].notes).toBeNull();              // nothing else saved either

    const answered = await patch({ phone_owner: PHONE, phone_decisions: [{ phone_e164: E164, decision: 'different' }] });
    expect(answered.status).toBe(200);
    expect(await ownerPhone(A.panel)).not.toBeNull();
    const flags = await pool.query(`select flagged_by from public.portal_phone_entry_flags
      where phone_e164 = $1 and apartment_number = $2`, [E164, A.panel]);
    expect(flags.rows).toEqual([{ flagged_by: h.actor!.id }]);
  });

  it('the Bllink queue: approving a "שיוך" of a phone registered under another name asks first', async () => {
    await card(A.queue, { owner_name: 'שלישי בדיקה' });
    const s = await pool.query<{ id: string }>(
      `insert into public.contact_sync_suggestions
         (apartment_number, field, current_value, proposed_value, source, phone_e164, person_role, person_name)
       values ($1, 'portal_link', null, $2, 'bllink', $2, 'owner', 'שלישי בדיקה') returning id`,
      [A.queue, E164]);
    const post = (body: unknown) => suggestionsRoute.POST(
      new Request('http://t/api/contacts/suggestions', { method: 'POST', body: JSON.stringify(body) }));

    const asked = await post({ action: 'approve', ids: [s.rows[0]!.id] });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ error: 'phone_conflict' });
    const still = await pool.query(`select status from public.contact_sync_suggestions where id = $1`, [s.rows[0]!.id]);
    expect(still.rows[0].status).toBe('pending');      // nothing resolved

    const answered = await post({
      action: 'approve', ids: [s.rows[0]!.id], phone_decisions: [{ phone_e164: E164, decision: 'different' }],
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ resolved: 1 });
  });

  it('a file import cannot ask — the row is refused (rolled back) and says where to answer', async () => {
    const before = await pool.query(`select 1 from public.contacts where apartment_number = $1`, [A.imported]);
    expect(before.rowCount).toBe(0);
    const err = await upsertContactAndLinkDebtor(
      { apartment_number: A.imported, owner_name: 'רביעי בדיקה', owner_phone: PHONE },
      { allowedFields: ['apartment_number', 'owner_name', 'owner_phone'], refusePhoneConflicts: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhoneEntryConflictError);
    expect((err as InstanceType<typeof PhoneEntryConflictError>).summary).toContain('כרטיס הדירה');
    const after = await pool.query(`select 1 from public.contacts where apartment_number = $1`, [A.imported]);
    expect(after.rowCount).toBe(0);
  });
});

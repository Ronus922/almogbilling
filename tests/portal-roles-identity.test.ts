import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { requireSeededAdmin } from './db-fixtures';
import { extractTenantPeople } from '@/lib/sync/tenantList';

// The portal by ROLE, one identity, identity approval, the entry warning and
// Bllink's people (03/10/2026) — against a throwaway database
// (WA_TEST_DATABASE_URL), through the real SQL and the real data layer.
// Fixtures are made here and removed by their exact apartments / ids
// (iron rule 12); the phones below exist nowhere else.
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

const { resolvePortalIdentity, findPortalRegistration } = await import('@/lib/db/portal/identity');
const { getPortalMyAccount } = await import('@/lib/db/portal/account');
const { resolvePortalReporter, insertPortalIssue } = await import('@/lib/db/portal/issueReport');
const {
  approveIdentity, checkPhoneEntry, endIdentity, registrationsOf, IdentityDecisionError, PhoneEntryConflictError,
} = await import('@/lib/db/portal/identityApprovals');
const { listBlockedPortalPhones } = await import('@/lib/db/portal/blockedPhones');
const { listSuggestionsForApartment, resolveSuggestions, suggestPortalLinks, getOwnerReplacementPreview } =
  await import('@/lib/db/contactSuggestions');

// Apartments (numeric — the registry keys on digits) and phones of this file.
const A = {
  own: '990701', ten: '990702', opr: '990703', hid: '990704', opf: '990705',
  same1: '990711', same2: '990712',
  diff1: '990721', diff2: '990722', diff3: '990723',
  nameless1: '990731', nameless2: '990732',
  entry1: '990741', entry2: '990742', entry3: '990743', entry4: '990744',
  bl: '990751', sale: '990752',
  det: '990761',
};
const APTS = Object.values(A);
const P = {
  own: '0527700001', ten: '0527700002', opr: '0527700003', hid: '0527700004', opf: '0527700005',
  same: '0527700011', diff: '0527700021', nameless: '0527700031',
  entryNo: '0527700041', entryYes: '0527700042', entryMgr: '0527700043',
  blKept: '0527700051', blGone: '0527700052', blNew: '0527700053', saleOld: '0527700054', saleNew: '0527700055',
  det: '0527700061',
};
const e164 = (local: string) => `+972${local.slice(1)}`;
const PHONES = Object.values(P).map(e164);

const made = { issues: [] as string[], scrapes: [] as string[] };
let adminId = '';

async function card(apt: string, cols: Record<string, string | null>) {
  const keys = Object.keys(cols);
  await pool.query(
    `insert into public.contacts (apartment_number, source, ${keys.join(', ')})
     values ($1, 'manual', ${keys.map((_, i) => `$${i + 2}`).join(', ')})`,
    [apt, ...keys.map((k) => cols[k])],
  );
}
async function link(apt: string, phone: string) {
  const r = await pool.query<{ role: string; is_active: boolean; detached_at: string | null; owner_name: string | null; id: string }>(
    `select id, role, is_active, detached_at::text, owner_name from public.apartment_owner_phones
      where apartment_number = $1 and phone_e164 = $2`, [apt, e164(phone)]);
  return r.rows[0] ?? null;
}
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function cleanup() {
  for (const id of made.issues) await pool.query(`delete from public.issues where id = $1`, [id]);
  for (const id of made.scrapes) await pool.query(`delete from public.bllink_scrapes where id = $1`, [id]);
  // Approvals and flags of THIS file's phones only (they exist nowhere else).
  await pool.query(`delete from public.portal_identity_approvals where phone_e164 = any($1::text[])`, [PHONES]);
  await pool.query(`delete from public.portal_phone_entry_flags where phone_e164 = any($1::text[])`, [PHONES]);
  // roster, contact_people and suggestions cascade from contacts
  await pool.query(`delete from public.contacts where apartment_number = any($1::text[])`, [APTS]);
}

d('portal roles + identity (03/10/2026)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
    adminId = await requireSeededAdmin(pool);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // ── 1. roles ───────────────────────────────────────────────────────────
  it('owner, tenant and operator link from the records the card SHOWS — each with its role, logged', async () => {
    await card(A.own, { owner_name: 'בעלים בדיקה', owner_phone: P.own });
    await card(A.ten, { owner_name: 'בעלים אחר', resident_type: 'tenant', tenant_name: 'שוכרת בדיקה', tenant_phone: P.ten });
    await card(A.opr, { owner_name: 'בעלים אחר', resident_type: 'operator', tenant_name: 'מפעיל בדיקה', tenant_phone: P.opr });
    await card(A.opf, { owner_name: 'בעלים אחר', operator_name: 'מפעיל שדה', operator_phone: P.opf });
    expect((await link(A.own, P.own))?.role).toBe('owner');
    expect((await link(A.ten, P.ten))).toMatchObject({ role: 'tenant', is_active: true, owner_name: 'שוכרת בדיקה' });
    expect((await link(A.opr, P.opr))).toMatchObject({ role: 'operator', is_active: true });
    expect((await link(A.opf, P.opf))).toMatchObject({ role: 'operator', is_active: true });
    const audit = await pool.query<{ role: string }>(
      `select metadata->>'role' as role from public.audit_log
        where action = 'portal_owner_phone_linked' and metadata->>'phone_e164' = $1`, [e164(P.ten)]);
    expect(audit.rows.map((r) => r.role)).toContain('tenant');
  });

  it('a phone in the tenant field the card hides (resident type "owner") opens nothing', async () => {
    await card(A.hid, { owner_name: 'בעלים גר בדירה', tenant_name: 'שוכר מוסתר', tenant_phone: P.hid });
    expect(await findPortalRegistration(e164(P.hid), { onlyActive: false })).toBeNull();
  });

  it('a broker / "בטיפול של" has no role: nothing in the schema can give it one', async () => {
    await expect(pool.query(
      `insert into public.apartment_owner_phones (apartment_number, owner_name, phone_e164, role)
       values ($1, 'מתווך', '+972527700099', 'broker')`, [A.own])).rejects.toThrow(/role_check/);
    const c = await pool.query<{ id: string }>(`select id from public.contacts where apartment_number = $1`, [A.own]);
    await expect(pool.query(
      `insert into public.contact_people (contact_id, role, name, phone) values ($1, 'broker', 'מתווך', '0527700099')`,
      [c.rows[0]!.id])).rejects.toThrow(/role_check/);
    // A phone written into the notes ("בטיפול של …") links nothing either.
    await pool.query(`update public.contacts set notes = 'בטיפול של משה 0527700098' where apartment_number = $1`, [A.own]);
    expect(await findPortalRegistration('+972527700098', { onlyActive: false })).toBeNull();
  });

  it('a tenant and an operator see the apartment debt and report faults, with their role on the issue', async () => {
    for (const [apt, phone, role] of [[A.ten, P.ten, 'tenant'], [A.opr, P.opr, 'operator']] as const) {
      const id = await resolvePortalIdentity(e164(phone));
      expect(id).toMatchObject({ status: 'ok', canSeeBuildingFinance: true });
      expect(id?.apartments).toEqual([expect.objectContaining({ apartmentNumber: apt, role, canSeeDebt: true })]);
      const acc = await getPortalMyAccount({ id: 's', phoneE164: e164(phone) });
      expect(acc).toEqual([expect.objectContaining({ apartment_number: apt, role, total_debt: 0 })]);

      const reporter = await resolvePortalReporter(e164(phone));
      expect(reporter).toMatchObject({ apartmentNumber: apt, role });
      const issueId = randomUUID();
      made.issues.push(issueId);
      await insertPortalIssue({
        id: issueId, reporter: reporter!, images: [],
        report: { location: 'לובי', area: null, description: 'בדיקת תפקיד', urgency: 'medium' },
      });
      const row = await pool.query(`select reporter_role, reporter_apartment from public.issues where id = $1`, [issueId]);
      expect(row.rows[0]).toEqual({ reporter_role: role, reporter_apartment: apt });
    }
  });

  // ── 2. one identity, the blocking rule ─────────────────────────────────
  it('owner in one apartment and tenant in another under the same name → one person, not blocked', async () => {
    await card(A.same1, { owner_name: 'דנה  לוי', owner_phone: P.same });
    await card(A.same2, { owner_name: 'מישהו', resident_type: 'tenant', tenant_name: 'דנה לוי', tenant_phone: P.same });
    const id = await resolvePortalIdentity(e164(P.same));
    expect(id).toMatchObject({ status: 'ok', name: 'דנה לוי' });
    expect(id?.apartments.map((a) => a.role)).toEqual(['owner', 'tenant']);
  });

  it('different names → blocked everywhere; approved → one name everywhere; a name added later → blocked again', async () => {
    await card(A.diff1, { owner_name: 'ס.נ נדל״ן', owner_phone: P.diff });
    await card(A.diff2, { owner_name: 'מישהו', resident_type: 'operator', tenant_name: 'סוניה', tenant_phone: P.diff });
    const phone = e164(P.diff);

    // blocked: no name in any of the places, no figure, an unidentified reporter
    expect(await resolvePortalIdentity(phone)).toMatchObject({ status: 'blocked', name: null, apartments: [] });
    expect(await getPortalMyAccount({ id: 's', phoneE164: phone })).toEqual([]);
    expect(await resolvePortalReporter(phone)).toMatchObject({ name: 'לא מזוהה', apartmentNumber: null, role: null, rosterId: null });
    const listed = (await listBlockedPortalPhones()).find((p) => p.phone_e164 === phone);
    expect(listed).toMatchObject({ category: 'company_contact', pending: null, flagged: false });

    // "אדם אחד" — logged
    const approvalId = await inTx((c) => approveIdentity(c, {
      phoneE164: phone, displayName: 'סוניה', names: ['ס.נ נדל״ן', 'סוניה'], actorId: adminId, source: 'blocked_screen',
      apartments: [{ apartment_number: A.diff1, relation: 'company_authorized' }, { apartment_number: A.diff2, relation: 'personal' }],
    }));
    const ok = await resolvePortalIdentity(phone);
    expect(ok).toMatchObject({ status: 'ok', name: 'סוניה', approvalId });
    expect((await resolvePortalReporter(phone))?.name).toBe('סוניה');
    expect((await getPortalMyAccount({ id: 's', phoneE164: phone })).map((a) => a.owner_display_name)).toEqual(['סוניה', 'סוניה']);
    expect((await listBlockedPortalPhones()).some((p) => p.phone_e164 === phone)).toBe(false);
    const audit = await pool.query(
      `select 1 from public.audit_log where action = 'portal_identity_approved' and entity_id = $1`, [phone]);
    expect(audit.rowCount).toBeGreaterThan(0);

    // a third apartment under a name the approval never saw
    await card(A.diff3, { owner_name: 'אדם אחר לגמרי', owner_phone: P.diff });
    expect((await resolvePortalIdentity(phone))?.status).toBe('blocked');

    // revoking also blocks (once the third apartment is gone, the approval alone decided)
    await pool.query(`delete from public.contacts where apartment_number = $1`, [A.diff3]);
    expect((await resolvePortalIdentity(phone))?.status).toBe('ok');
    expect(await inTx((c) => endIdentity(c, { id: approvalId, action: 'revoke', actorId: adminId }))).toBe(true);
    expect((await resolvePortalIdentity(phone))?.status).toBe('blocked');
  });

  it('a nameless record among several apartments is blocked, and cannot be approved away', async () => {
    await card(A.nameless1, { owner_name: null, owner_phone: P.nameless });
    await card(A.nameless2, { owner_name: 'שם קיים', owner_phone: P.nameless });
    const phone = e164(P.nameless);
    expect((await resolvePortalIdentity(phone))?.status).toBe('blocked');
    expect((await listBlockedPortalPhones()).find((p) => p.phone_e164 === phone)?.category).toBe('missing_name');
    await expect(inTx((c) => approveIdentity(c, {
      phoneE164: phone, displayName: 'שם קיים', names: ['', 'שם קיים'], actorId: adminId, source: 'blocked_screen',
      apartments: [{ apartment_number: A.nameless1, relation: 'personal' }, { apartment_number: A.nameless2, relation: 'personal' }],
    }))).rejects.toBeInstanceOf(IdentityDecisionError);
  });

  // ── 3. the entry warning ───────────────────────────────────────────────
  async function typePhone(apt: string, phone: string, name: string, decision?: 'same' | 'different', canManagePortal = false) {
    return inTx(async (c) => {
      const before = await registrationsOf(c, apt);
      await c.query(`update public.contacts set owner_name = $2, owner_phone = $3 where apartment_number = $1`, [apt, name, phone]);
      await checkPhoneEntry(c, {
        apartment: apt, before,
        actor: { id: adminId, canManagePortal },
        decisions: decision ? [{
          phone_e164: e164(phone), decision,
          identity: canManagePortal ? {
            display_name: 'רונן משולם',
            apartments: [{ apartment_number: apt, relation: 'personal' }, { apartment_number: A.entry1, relation: 'personal' }],
          } : undefined,
        }] : undefined,
      });
    });
  }

  it('entry warning: an unanswered conflict saves NOTHING; "no" saves, blocks and flags a typing mistake', async () => {
    await card(A.entry1, { owner_name: 'רונן משולם', owner_phone: P.entryNo });
    await card(A.entry2, { owner_name: null });
    const err = await typePhone(A.entry2, P.entryNo, 'אלי אברג׳יל').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhoneEntryConflictError);
    expect((err as InstanceType<typeof PhoneEntryConflictError>).conflicts[0]).toMatchObject({
      apartment_number: A.entry2, entered_name: 'אלי אברג׳יל', others: [{ apartment_number: A.entry1, name: 'רונן משולם' }],
    });
    expect(await link(A.entry2, P.entryNo)).toBeNull();   // rolled back

    await typePhone(A.entry2, P.entryNo, 'אלי אברג׳יל', 'different');
    expect((await link(A.entry2, P.entryNo))?.is_active).toBe(true);
    expect((await resolvePortalIdentity(e164(P.entryNo)))?.status).toBe('blocked');
    const all = await listBlockedPortalPhones();
    expect(all.find((p) => p.phone_e164 === e164(P.entryNo))).toMatchObject({ flagged: true, category: 'unrelated' });
    // "שמות ללא קשר" first on the screen — before the nameless phone of the test above
    const order = all.map((p) => p.phone_e164);
    expect(order.indexOf(e164(P.entryNo))).toBeLessThan(order.indexOf(e164(P.nameless)));
    const audit = await pool.query(`select actor_user_id from public.audit_log
      where action = 'portal_phone_entry_flagged' and entity_id = $1`, [e164(P.entryNo)]);
    expect(audit.rows[0]?.actor_user_id).toBe(adminId);
  });

  it('entry warning: "yes" without portal_manage → a PENDING request and the phone stays blocked', async () => {
    await pool.query(`update public.contacts set owner_phone = $2 where apartment_number = $1`, [A.entry1, P.entryYes]);
    await card(A.entry3, { owner_name: null });
    await typePhone(A.entry3, P.entryYes, 'רוני משולם', 'same', false);
    expect((await resolvePortalIdentity(e164(P.entryYes)))?.status).toBe('blocked');
    const listed = (await listBlockedPortalPhones()).find((p) => p.phone_e164 === e164(P.entryYes));
    expect(listed?.pending).not.toBeNull();
  });

  it('entry warning: "yes" with portal_manage → approved there and then, one name', async () => {
    await pool.query(`update public.contacts set owner_phone = $2 where apartment_number = $1`, [A.entry1, P.entryMgr]);
    await card(A.entry4, { owner_name: null });
    await typePhone(A.entry4, P.entryMgr, 'רונן  משולם בע״מ', 'same', true);
    expect(await resolvePortalIdentity(e164(P.entryMgr))).toMatchObject({ status: 'ok', name: 'רונן משולם' });
    expect((await resolvePortalIdentity(e164(P.entryMgr)))?.apartments.map((a) => a.apartmentNumber))
      .toEqual([A.entry1, A.entry4].sort());
  });

  // ── 4. the detaches of 03/10/2026 hold in their role ───────────────────
  it('a detach holds while the record keeps the phone in that role — and lapses when the role is fixed', async () => {
    await card(A.det, { owner_name: 'בעלים רשום', owner_phone: P.det });
    const row = await link(A.det, P.det);
    await pool.query(
      `update public.apartment_owner_phones set is_active = false, detached_at = now(), detach_reason = 'audit_2026_10'
        where id = $1`, [row!.id]);
    // the same phone also in the tenant section: owner wins → same role → still detached
    await pool.query(`update public.contacts set resident_type = 'tenant', tenant_name = 'שוכר', tenant_phone = $2
                       where apartment_number = $1`, [A.det, P.det]);
    expect(await link(A.det, P.det)).toMatchObject({ is_active: false, role: 'owner' });
    expect((await resolvePortalIdentity(e164(P.det)))).toBeNull();
    // Ronen fixes the record: the phone leaves the owner field → its role is now tenant → released, linked as tenant
    await pool.query(`update public.contacts set owner_phone = null where apartment_number = $1`, [A.det]);
    expect(await link(A.det, P.det)).toMatchObject({ is_active: true, role: 'tenant', detached_at: null });
    const released = await pool.query(`select metadata->>'reason' as reason from public.audit_log
      where action = 'portal_owner_phone_detach_released' and entity_id = $1`, [row!.id]);
    expect(released.rows.map((r) => r.reason)).toContain('role_changed');
  });

  // ── 5. Bllink ──────────────────────────────────────────────────────────
  it('Bllink: a person who vanished → "ניתוק"; a new one → "שיוך" with the role; nothing applied by itself', async () => {
    await card(A.bl, { owner_name: 'נשאר', owner_phone: P.blKept });
    await pool.query(`insert into public.contact_people (contact_id, role, name, phone)
      select id, 'owner', 'נעלם', $2 from public.contacts where apartment_number = $1`, [A.bl, P.blGone]);
    expect((await link(A.bl, P.blGone))?.is_active).toBe(true);

    const people = extractTenantPeople({ apartments: [{ apartmentNum: A.bl, tenants: [
      { tenant: { isActive: true, isPrimary: true }, details: { tenantType: 'owner', name: 'נשאר', phone: P.blKept } },
      { tenant: { isActive: false }, details: { tenantType: 'owner', name: 'נעלם', phone: P.blGone } },
      { tenant: { isActive: true }, details: { tenantType: 'renter', name: 'שוכרת חדשה', phone: P.blNew } },
    ] }] });
    expect(people[A.bl]!.map((p) => p.phone)).toEqual([P.blKept, P.blNew]);   // isActive=false is gone

    const s = await pool.query<{ id: string }>(
      `insert into public.bllink_scrapes (status, tenant_list_ok, list_people) values ('success', true, $1::jsonb) returning id`,
      [JSON.stringify(people)]);
    made.scrapes.push(s.rows[0]!.id);
    const out = await suggestPortalLinks(s.rows[0]!.id);
    expect(out).toMatchObject({ suggested_link: 1, suggested_unlink: 1 });

    const sug = await listSuggestionsForApartment(A.bl);
    const linkS = sug.find((x) => x.field === 'portal_link')!;
    const unlinkS = sug.find((x) => x.field === 'portal_unlink')!;
    expect(linkS).toMatchObject({
      phone_e164: e164(P.blNew), person_role: 'tenant', person_name: 'שוכרת חדשה', access: true, marks_rented: true,
    });
    expect(unlinkS).toMatchObject({ phone_e164: e164(P.blGone), access: true });
    // nothing changed by itself
    expect((await link(A.bl, P.blGone))?.is_active).toBe(true);
    expect(await link(A.bl, P.blNew)).toBeNull();

    // "אשר הכל" never approves an access suggestion
    expect(await resolveSuggestions([linkS.id, unlinkS.id], 'approve', adminId)).toBe(0);
    // one by one: unlink detaches, link writes the person onto the card (role tenant)
    expect(await resolveSuggestions([unlinkS.id], 'approve', adminId)).toBe(1);
    expect(await link(A.bl, P.blGone)).toMatchObject({ is_active: false });
    expect(await resolveSuggestions([linkS.id], 'approve', adminId)).toBe(1);
    expect(await link(A.bl, P.blNew)).toMatchObject({ is_active: true, role: 'tenant' });
  });

  it('Bllink owner name: "תיקון שם" detaches nothing; "החלפת בעלים" detaches exactly what its dialog showed', async () => {
    // audit_log keeps every run's rows — read only this run's
    const since = (await pool.query<{ t: string }>(`select clock_timestamp()::text as t`)).rows[0]!.t;
    await card(A.sale, { owner_name: 'בעלים ותיק', owner_phone: P.saleOld });
    const ins = async (to: string) => (await pool.query<{ id: string }>(
      `insert into public.contact_sync_suggestions (apartment_number, field, current_value, proposed_value, source)
       values ($1, 'owner_name', 'x', $2, 'bllink') returning id`, [A.sale, to])).rows[0]!.id;

    const rename = await ins('בעלים  ותיק בע״מ');
    expect(await resolveSuggestions([rename], 'approve_rename', adminId)).toBe(1);
    expect((await link(A.sale, P.saleOld))?.is_active).toBe(true);

    const replace = await ins('קונה חדש');
    await pool.query(`insert into public.contact_sync_suggestions (apartment_number, field, current_value, proposed_value, source)
                      values ($1, 'owner_phone', $2, $3, 'bllink')`, [A.sale, P.saleOld, P.saleNew]);
    const preview = await getOwnerReplacementPreview(replace);
    expect(preview?.detach.map((x) => x.phone_e164)).toEqual([e164(P.saleOld)]);
    expect(preview?.new_phone).toBe(P.saleNew);
    expect(await resolveSuggestions([replace], 'approve_replace', adminId)).toBe(2);
    expect(await link(A.sale, P.saleOld)).toMatchObject({ is_active: false });
    expect(await link(A.sale, P.saleNew)).toMatchObject({ is_active: true, owner_name: 'קונה חדש' });
    const modes = await pool.query(`select metadata->>'mode' as mode from public.audit_log
      where action = 'contact_owner_name_approved' and metadata->>'apartment_number' = $1 and created_at >= $2::timestamptz
      order by created_at`, [A.sale, since]);
    expect(modes.rows.map((r) => r.mode)).toEqual(['rename', 'replace']);
  });
});

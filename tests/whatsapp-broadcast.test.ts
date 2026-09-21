import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { Pool } from 'pg';

// resolveBroadcastRecipients() honors contacts.owner_is_primary_contact /
// tenant_is_primary_contact ("מקבל הודעות") the same way it already honors
// contact_people.is_primary_contact — EXCEPT for an explicit debtor_ids
// audience, where the recipients were hand-picked and silently dropping one
// on an opt-out flag would be confusing rather than helpful.
//
// For owners/tenants/all, contacts is the base (not debtors): an apartment with
// no active debt record still resolves a recipient, with debtorId: null. An
// archived-only debtor is treated exactly like no debtor at all (the join to
// debtors filters is_archived = false).
//
// Runs ONLY against a throwaway database (WA_TEST_DATABASE_URL), never prod —
// same gate as tests/wa-queue.test.ts.
const TEST_URL = process.env.WA_TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

let pool: Pool;
vi.mock('@/lib/db', () => ({
  query: (text: string, params?: unknown[]) => pool.query(text, params),
}));

const { resolveBroadcastRecipients, resolveConsolidatedBroadcastRecipients } = await import('@/lib/whatsapp-broadcast');

/** Every id this suite creates, so teardown removes exactly those (CLAUDE.md
 *  iron rule 12 — never clean up by filter). */
const made = { contacts: [] as string[], debtors: [] as string[], contactPeople: [] as string[] };

let n = 0;
/** A unique, valid Israeli mobile local number: "050" + 7 digits. */
const uniqPhone = () => `050${String(1000000 + n++).padStart(7, '0')}`;
const uniqApt = () => `wa-bcast-test-${Date.now()}-${n++}`;

interface ContactSpec {
  owner_phone?: string | null;
  owner_is_primary_contact?: boolean;
  owner_name?: string | null;
  tenant_phone?: string | null;
  tenant_is_primary_contact?: boolean;
  tenant_name?: string | null;
  apartment_number?: string;
}

/** Inserts just the contact row (no debtor at all). Returns the contact id. */
async function makeContact(spec: ContactSpec): Promise<string> {
  const contact = await pool.query<{ id: string }>(
    `insert into public.contacts
       (apartment_number, owner_phone, owner_is_primary_contact, owner_name,
        tenant_phone, tenant_is_primary_contact, tenant_name)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      spec.apartment_number ?? uniqApt(),
      spec.owner_phone ?? null,
      spec.owner_is_primary_contact ?? true,
      spec.owner_name ?? null,
      spec.tenant_phone ?? null,
      spec.tenant_is_primary_contact ?? false,
      spec.tenant_name ?? null,
    ],
  );
  const contactId = contact.rows[0]!.id;
  made.contacts.push(contactId);
  return contactId;
}

/** Creates a contact + a linked, non-archived debtor for it — the shape
 *  resolveBroadcastRecipients actually reads from (contacts is the source of
 *  truth whenever contact_id is linked, per DEBTOR_COLS). Returns the debtor id. */
async function makeLinkedDebtor(spec: ContactSpec): Promise<string> {
  const contactId = await makeContact(spec);
  const debtor = await pool.query<{ id: string; apartment_number: string }>(
    `insert into public.debtors (apartment_number, contact_id, is_archived)
     select apartment_number, id, false from public.contacts where id = $1
     returning id`,
    [contactId],
  );
  const debtorId = debtor.rows[0]!.id;
  made.debtors.push(debtorId);
  return debtorId;
}

/** Creates a contact + a linked but ARCHIVED debtor — resolveBroadcastRecipients
 *  must treat this exactly like "no debtor" (the join excludes archived rows). */
async function makeArchivedDebtor(spec: ContactSpec): Promise<{ contactId: string; debtorId: string }> {
  const contactId = await makeContact(spec);
  const debtor = await pool.query<{ id: string }>(
    `insert into public.debtors (apartment_number, contact_id, is_archived)
     select apartment_number, id, true from public.contacts where id = $1
     returning id`,
    [contactId],
  );
  const debtorId = debtor.rows[0]!.id;
  made.debtors.push(debtorId);
  return { contactId, debtorId };
}

function intl(local: string): string {
  return `972${local.slice(1)}`;
}

/** Inserts one contact_people extra (additional owner/tenant beyond the
 *  primary on the contact row). isPrimaryContact defaults to true ("מקבל
 *  הודעות" on) — pass false to simulate that person opting out. */
async function makeExtra(
  contactId: string, role: 'owner' | 'tenant', phone: string,
  opts: { isPrimaryContact?: boolean; name?: string } = {},
): Promise<void> {
  const extra = await pool.query<{ id: string }>(
    `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
     values ($1, $2, $3, $4, $5, 0)
     returning id`,
    [contactId, role, opts.name ?? 'Extra', phone, opts.isPrimaryContact ?? true],
  );
  made.contactPeople.push(extra.rows[0]!.id);
}

d('resolveBroadcastRecipients — primary-contact opt-out enforcement', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
    for (const id of made.contactPeople) await pool.query(`delete from public.contact_people where id = $1`, [id]);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('owners: excludes an owner with owner_is_primary_contact = false', async () => {
    const blockedPhone = uniqPhone();
    const allowedPhone = uniqPhone();
    await makeLinkedDebtor({ owner_phone: blockedPhone, owner_is_primary_contact: false });
    await makeLinkedDebtor({ owner_phone: allowedPhone, owner_is_primary_contact: true });

    const recipients = await resolveBroadcastRecipients({ type: 'owners' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).not.toContain(intl(blockedPhone));
    expect(phones).toContain(intl(allowedPhone));
  });

  it('tenants: excludes a tenant with tenant_is_primary_contact = false', async () => {
    const blockedPhone = uniqPhone();
    const allowedPhone = uniqPhone();
    await makeLinkedDebtor({ tenant_phone: blockedPhone, tenant_is_primary_contact: false });
    await makeLinkedDebtor({ tenant_phone: allowedPhone, tenant_is_primary_contact: true });

    const recipients = await resolveBroadcastRecipients({ type: 'tenants' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).not.toContain(intl(blockedPhone));
    expect(phones).toContain(intl(allowedPhone));
  });

  it("all: an opted-out owner falls back to an opted-in tenant on the same apartment", async () => {
    const ownerPhone = uniqPhone();
    const tenantPhone = uniqPhone();
    await makeLinkedDebtor({
      owner_phone: ownerPhone, owner_is_primary_contact: false,
      tenant_phone: tenantPhone, tenant_is_primary_contact: true,
    });

    const recipients = await resolveBroadcastRecipients({ type: 'all' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).not.toContain(intl(ownerPhone));
    expect(phones).toContain(intl(tenantPhone));
  });

  it('all: an apartment with both owner and tenant opted out contributes no recipient', async () => {
    const ownerPhone = uniqPhone();
    const tenantPhone = uniqPhone();
    await makeLinkedDebtor({
      owner_phone: ownerPhone, owner_is_primary_contact: false,
      tenant_phone: tenantPhone, tenant_is_primary_contact: false,
    });

    const recipients = await resolveBroadcastRecipients({ type: 'all' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).not.toContain(intl(ownerPhone));
    expect(phones).not.toContain(intl(tenantPhone));
  });

  it('debtor_ids: an explicitly picked, opted-out owner is still included', async () => {
    const blockedPhone = uniqPhone();
    const debtorId = await makeLinkedDebtor({ owner_phone: blockedPhone, owner_is_primary_contact: false });

    const recipients = await resolveBroadcastRecipients({ type: 'debtor_ids', debtor_ids: [debtorId] });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).toContain(intl(blockedPhone));
  });

  it('owners: an apartment with NO debt record still resolves a recipient (contacts is the base)', async () => {
    const phone = uniqPhone();
    const contactId = await makeContact({ owner_phone: phone, owner_is_primary_contact: true });

    const recipients = await resolveBroadcastRecipients({ type: 'owners' });
    const match = recipients.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined();
    expect(match?.contactId).toBe(contactId);
    expect(match?.debtorId).toBeNull();
    expect(match?.debtor.total_debt ?? null).toBeNull();
  });

  it('owners: an apartment whose only debtor is archived is treated as having no debt record', async () => {
    const phone = uniqPhone();
    const { contactId } = await makeArchivedDebtor({ owner_phone: phone, owner_is_primary_contact: true });

    const recipients = await resolveBroadcastRecipients({ type: 'owners' });
    const match = recipients.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined();
    expect(match?.contactId).toBe(contactId);
    expect(match?.debtorId).toBeNull();
  });

  it('owners: an apartment with NO debt record still resolves its ADDITIONAL owner (contact_people extras join through contacts)', async () => {
    const primaryPhone = uniqPhone();
    const extraPhone = uniqPhone();
    const contactId = await makeContact({ owner_phone: primaryPhone, owner_is_primary_contact: true });
    await makeExtra(contactId, 'owner', extraPhone);

    const recipients = await resolveBroadcastRecipients({ type: 'owners' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).toContain(intl(primaryPhone));
    expect(phones).toContain(intl(extraPhone));
    const match = recipients.find((r) => r.phoneIntl === intl(extraPhone));
    expect(match?.contactId).toBe(contactId);
    expect(match?.debtorId).toBeNull();
  });

  it('tenants: a no-debt apartment\'s extra tenant is included; an extra on an unrelated role is not', async () => {
    const extraTenantPhone = uniqPhone();
    const extraOwnerPhone = uniqPhone();
    const contactId = await makeContact({});
    await makeExtra(contactId, 'tenant', extraTenantPhone);
    await makeExtra(contactId, 'owner', extraOwnerPhone);

    const recipients = await resolveBroadcastRecipients({ type: 'tenants' });
    const phones = recipients.map((r) => r.phoneIntl);
    expect(phones).toContain(intl(extraTenantPhone));
    expect(phones).not.toContain(intl(extraOwnerPhone));
  });
});

// PR ב': the debt-message counterpart — groups by phone instead of picking one
// row per phone, so a recipient holding several apartments gets ALL of them
// (the dedup bug's fix). Reuses the exact same per-row eligibility as
// resolveBroadcastRecipients (fetchAudienceRows), so for a given audience the
// SET of phones the two functions produce must always be identical — only the
// SHAPE differs (one row per phone vs. one row per phone WITH an apartments[]
// list). That equivalence is asserted directly below, not just assumed.
d('resolveConsolidatedBroadcastRecipients — multi-apartment grouping + apartment-level opt-out', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
    for (const id of made.contactPeople) await pool.query(`delete from public.contact_people where id = $1`, [id]);
    for (const id of made.debtors) await pool.query(`delete from public.debtors where id = $1`, [id]);
    for (const id of made.contacts) await pool.query(`delete from public.contacts where id = $1`, [id]);
    await pool.end();
  });

  it('owners: two apartments sharing one phone consolidate into ONE recipient with 2 apartments (the dedup bug, fixed)', async () => {
    const phone = uniqPhone();
    const aptA = uniqApt();
    const aptB = uniqApt();
    await makeLinkedDebtor({ owner_phone: phone, owner_is_primary_contact: true, apartment_number: aptA, owner_name: 'ראובן כהן' });
    await makeLinkedDebtor({ owner_phone: phone, owner_is_primary_contact: true, apartment_number: aptB, owner_name: 'ראובן כהן' });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'owners' });
    const match = consolidated.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined();
    expect(match!.apartments.map((a) => a.apartment_number).sort()).toEqual([aptA, aptB].sort());
    expect(match!.rawNames).toEqual(['ראובן כהן', 'ראובן כהן']);
  });

  it('owners: an apartment with owner_is_primary_contact = false is excluded from the list even though the SAME phone has another apartment that is opted in', async () => {
    const phone = uniqPhone();
    const optedOutApt = uniqApt();
    const optedInApt = uniqApt();
    await makeLinkedDebtor({ owner_phone: phone, owner_is_primary_contact: false, apartment_number: optedOutApt });
    await makeLinkedDebtor({ owner_phone: phone, owner_is_primary_contact: true, apartment_number: optedInApt });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'owners' });
    const match = consolidated.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined(); // the phone still gets a message, via the opted-in apartment
    const numbers = match!.apartments.map((a) => a.apartment_number);
    expect(numbers).toContain(optedInApt);
    expect(numbers).not.toContain(optedOutApt);
  });

  it('tenants: an apartment with tenant_is_primary_contact = false is excluded, same as the owners case', async () => {
    const phone = uniqPhone();
    const optedOutApt = uniqApt();
    const optedInApt = uniqApt();
    await makeLinkedDebtor({ tenant_phone: phone, tenant_is_primary_contact: false, apartment_number: optedOutApt });
    await makeLinkedDebtor({ tenant_phone: phone, tenant_is_primary_contact: true, apartment_number: optedInApt });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'tenants' });
    const match = consolidated.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined();
    const numbers = match!.apartments.map((a) => a.apartment_number);
    expect(numbers).toContain(optedInApt);
    expect(numbers).not.toContain(optedOutApt);
  });

  it("all: an extra person's contact_people.is_primary_contact = false keeps THEIR apartment out of another apartment's list on the same phone", async () => {
    const sharedPhone = uniqPhone();
    const primaryApt = uniqApt();
    const extraApt = uniqApt();
    await makeLinkedDebtor({ owner_phone: sharedPhone, owner_is_primary_contact: true, apartment_number: primaryApt });
    const extraContactId = await makeContact({ apartment_number: extraApt });
    // This person opted out ("מקבל הודעות" off) — their apartment must not
    // ride along on `sharedPhone` just because another apartment uses it.
    await makeExtra(extraContactId, 'owner', sharedPhone, { isPrimaryContact: false });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'all' });
    const match = consolidated.find((r) => r.phoneIntl === intl(sharedPhone));
    expect(match).toBeDefined();
    const numbers = match!.apartments.map((a) => a.apartment_number);
    expect(numbers).toContain(primaryApt);
    expect(numbers).not.toContain(extraApt);
  });

  it("all: an extra person's contact_people.is_primary_contact = true DOES add their apartment to an existing phone's list", async () => {
    const sharedPhone = uniqPhone();
    const primaryApt = uniqApt();
    const extraApt = uniqApt();
    await makeLinkedDebtor({ owner_phone: sharedPhone, owner_is_primary_contact: true, apartment_number: primaryApt });
    const extraContactId = await makeContact({ apartment_number: extraApt });
    await makeExtra(extraContactId, 'owner', sharedPhone, { isPrimaryContact: true, name: 'שכן שותף' });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'all' });
    const match = consolidated.find((r) => r.phoneIntl === intl(sharedPhone));
    expect(match).toBeDefined();
    const numbers = match!.apartments.map((a) => a.apartment_number);
    expect(numbers).toContain(primaryApt);
    expect(numbers).toContain(extraApt);
    expect(match!.rawNames).toContain('שכן שותף');
  });

  it('all: an apartment with NO debt record still contributes to consolidation (contacts is the base)', async () => {
    const phone = uniqPhone();
    const apt = uniqApt();
    const contactId = await makeContact({ owner_phone: phone, owner_is_primary_contact: true, apartment_number: apt });

    const consolidated = await resolveConsolidatedBroadcastRecipients({ type: 'all' });
    const match = consolidated.find((r) => r.phoneIntl === intl(phone));
    expect(match).toBeDefined();
    expect(match!.apartments).toHaveLength(1);
    expect(match!.apartments[0].contactId).toBe(contactId);
    expect(match!.apartments[0].debtorId).toBeNull();
  });

  // The screen's recipient counter must show the SAME number regardless of
  // which path a message routes through — both are one-message-per-phone,
  // only the CONTENT differs. This proves the two resolvers' phone SETS never
  // diverge, for every audience type, not just assumed from shared code.
  it.each(['owners', 'tenants', 'all'] as const)(
    '%s: resolveConsolidatedBroadcastRecipients and resolveBroadcastRecipients agree on the exact same set of phones',
    async (type) => {
      const p1 = uniqPhone();
      const p2 = uniqPhone();
      const p3 = uniqPhone();
      await makeLinkedDebtor({ owner_phone: p1, owner_is_primary_contact: true, tenant_phone: p2, tenant_is_primary_contact: true });
      await makeLinkedDebtor({ owner_phone: p1, owner_is_primary_contact: true }); // same owner phone, 2nd apartment
      await makeLinkedDebtor({ owner_phone: p3, owner_is_primary_contact: false }); // opted out — excluded from both

      const [plain, consolidated] = await Promise.all([
        resolveBroadcastRecipients({ type }),
        resolveConsolidatedBroadcastRecipients({ type }),
      ]);
      const plainPhones = new Set(plain.map((r) => r.phoneIntl));
      const consolidatedPhones = new Set(consolidated.map((r) => r.phoneIntl));
      expect(consolidatedPhones).toEqual(plainPhones);
    },
  );
});

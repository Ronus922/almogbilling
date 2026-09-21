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

const { resolveBroadcastRecipients } = await import('@/lib/whatsapp-broadcast');

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
  tenant_phone?: string | null;
  tenant_is_primary_contact?: boolean;
}

/** Inserts just the contact row (no debtor at all). Returns the contact id. */
async function makeContact(spec: ContactSpec): Promise<string> {
  const contact = await pool.query<{ id: string }>(
    `insert into public.contacts
       (apartment_number, owner_phone, owner_is_primary_contact, tenant_phone, tenant_is_primary_contact)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      uniqApt(),
      spec.owner_phone ?? null,
      spec.owner_is_primary_contact ?? true,
      spec.tenant_phone ?? null,
      spec.tenant_is_primary_contact ?? false,
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
 *  primary on the contact row). */
async function makeExtra(contactId: string, role: 'owner' | 'tenant', phone: string): Promise<void> {
  const extra = await pool.query<{ id: string }>(
    `insert into public.contact_people (contact_id, role, name, phone, is_primary_contact, sort_order)
     values ($1, $2, 'Extra', $3, true, 0)
     returning id`,
    [contactId, role, phone],
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

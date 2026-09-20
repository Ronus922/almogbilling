import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { Pool } from 'pg';

// resolveBroadcastRecipients() now honors contacts.owner_is_primary_contact /
// tenant_is_primary_contact ("מקבל הודעות") the same way it already honors
// contact_people.is_primary_contact — EXCEPT for an explicit debtor_ids
// audience, where the recipients were hand-picked and silently dropping one
// on an opt-out flag would be confusing rather than helpful.
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
const made = { contacts: [] as string[], debtors: [] as string[] };

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

/** Creates a contact + a linked, non-archived debtor for it — the shape
 *  resolveBroadcastRecipients actually reads from (contacts is the source of
 *  truth whenever contact_id is linked, per DEBTOR_COLS). Returns the debtor id. */
async function makeLinkedDebtor(spec: ContactSpec): Promise<string> {
  const apt = uniqApt();
  const contact = await pool.query<{ id: string }>(
    `insert into public.contacts
       (apartment_number, owner_phone, owner_is_primary_contact, tenant_phone, tenant_is_primary_contact)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      apt,
      spec.owner_phone ?? null,
      spec.owner_is_primary_contact ?? true,
      spec.tenant_phone ?? null,
      spec.tenant_is_primary_contact ?? false,
    ],
  );
  const contactId = contact.rows[0]!.id;
  made.contacts.push(contactId);

  const debtor = await pool.query<{ id: string }>(
    `insert into public.debtors (apartment_number, contact_id, is_archived)
     values ($1, $2, false)
     returning id`,
    [apt, contactId],
  );
  const debtorId = debtor.rows[0]!.id;
  made.debtors.push(debtorId);
  return debtorId;
}

function intl(local: string): string {
  return `972${local.slice(1)}`;
}

d('resolveBroadcastRecipients — primary-contact opt-out enforcement', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL, max: 4 });
    pool.on('error', () => undefined);
  });

  afterAll(async () => {
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
});

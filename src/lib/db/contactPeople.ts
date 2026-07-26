import 'server-only';
import { query, withTransaction } from '@/lib/db';
import type { ContactPersonInput, ContactPersonRole } from '@/lib/types/contacts';

// public.contact_people — the ADDITIONAL owners/tenants of an apartment (the
// first person of each role stays in contacts.owner_* / tenant_*). Two jobs:
//   1. replaceContactPeople — the apartment card saves the whole list at once.
//   2. listExtraRecipients* — recipient resolution for WhatsApp sends and
//      broadcasts, which read debtors and join back through debtors.contact_id.

/**
 * Replace a contact's extra people with `people`, in order. Delete-all +
 * insert inside one transaction: the client always sends the complete list, so
 * a diff would only add failure modes. sort_order is the array index within the
 * role, so the card's ordering round-trips.
 */
export async function replaceContactPeople(
  contactId: string,
  people: ContactPersonInput[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`delete from public.contact_people where contact_id = $1`, [contactId]);
    if (people.length === 0) return;

    const perRole: Record<ContactPersonRole, number> = { owner: 0, tenant: 0 };
    const values: string[] = [];
    const params: unknown[] = [contactId];
    for (const p of people) {
      params.push(p.role, p.name, p.phone, p.email, p.is_primary_contact, perRole[p.role]++);
      const n = params.length;
      values.push(`($1, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`);
    }
    await client.query(
      `insert into public.contact_people
         (contact_id, role, name, phone, email, is_primary_contact, sort_order)
       values ${values.join(', ')}`,
      params,
    );
  });
}

/** One extra person resolved as a message recipient of a debtor's apartment. */
export interface ExtraRecipient {
  debtor_id: string;
  role: ContactPersonRole;
  name: string | null;
  /** Raw stored phone — the caller normalises/validates it. */
  phone: string;
}

const RECIPIENT_SELECT = `
  select d.id as debtor_id, p.role, p.name, p.phone
  from public.contact_people p
  join public.debtors d on d.contact_id = p.contact_id`;

const RECIPIENT_FILTER = `
  p.is_primary_contact = true
  and p.phone is not null and btrim(p.phone) <> ''
  and p.role = any($1::text[])`;

const RECIPIENT_ORDER = ` order by p.role, p.sort_order, p.id`;

/**
 * Extra recipients for an explicit set of debtors (bulk send, or a broadcast
 * targeting picked debtors). Archived debtors are NOT filtered out — an explicit
 * selection wins, exactly like the primary-phone path it complements.
 */
export async function listExtraRecipientsForDebtors(
  debtorIds: string[],
  roles: ContactPersonRole[],
): Promise<ExtraRecipient[]> {
  if (debtorIds.length === 0 || roles.length === 0) return [];
  const r = await query<ExtraRecipient>(
    `${RECIPIENT_SELECT} where ${RECIPIENT_FILTER} and d.id = any($2::uuid[])${RECIPIENT_ORDER}`,
    [roles, debtorIds],
  );
  return r.rows;
}

/** Extra recipients across every active (non-archived) debtor. */
export async function listExtraRecipientsForAllDebtors(
  roles: ContactPersonRole[],
): Promise<ExtraRecipient[]> {
  if (roles.length === 0) return [];
  const r = await query<ExtraRecipient>(
    `${RECIPIENT_SELECT} where ${RECIPIENT_FILTER} and d.is_archived = false${RECIPIENT_ORDER}`,
    [roles],
  );
  return r.rows;
}

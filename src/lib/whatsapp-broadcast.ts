import 'server-only';
import { query } from '@/lib/db';
import {
  normalizePhone,
  cleanPhoneField,
} from '@/lib/whatsapp';
import {
  listExtraRecipientsForAllContacts,
  listExtraRecipientsForDebtors,
  type ContactExtraRecipient,
  type ExtraRecipient,
} from '@/lib/db/contactPeople';
import type { TemplateDebtor } from '@/lib/whatsapp-template';
import type { BroadcastAudience } from '@/types/whatsapp';
import type { ContactPersonRole } from '@/lib/types/contacts';

// Audience → recipient resolution for WhatsApp broadcasts. The actual sending is
// now the durable delivery queue's job (src/lib/wa-queue/*, drained by the
// standalone worker) — the old fire-and-forget in-process runner was retired in
// the Phase 2 cutover. For owners/tenants/all, this module resolves recipients
// from `contacts` (the apartment registry — every apartment, debt or not), LEFT
// JOINing the active debtor when one exists; an apartment with no debt record
// still gets its owner/tenant recipients, just with zero-valued debt template
// fields. The campaigns route (POST /api/whatsapp/campaigns) and the live
// estimate (POST /api/whatsapp/audience-count) both call it; the estimate also
// calls resolveConsolidatedBroadcastRecipients (below) for a debt message.

export interface BroadcastRecipient {
  debtor: TemplateDebtor;
  /** Apartment identity (public.contacts.id) — always present, since contacts
   *  is the source of truth regardless of debt status. */
  contactId: string;
  /** The active debt record's id, or null for an apartment with none. Never
   *  repurposed to hold a contact id — a null here means exactly "no debt". */
  debtorId: string | null;
  /** International digits ("972XXXXXXXXX"). */
  phoneIntl: string;
}

interface ContactRow {
  contact_id: string | null;
  debtor_id: string | null;
  owner_name: string | null;
  tenant_name: string | null;
  apartment_number: string;
  total_debt: number | null;
  management_fees: number | null;
  hot_water_debt: number | null;
  phone_owner: string | null;
  phone_tenant: string | null;
  owner_primary: boolean;
  tenant_primary: boolean;
}

// owners/tenants/all — contacts is the base, the active (non-archived) debtor is
// LEFT JOINed so an apartment with no debt record still produces a row.
const CONTACT_COLS = `
  c.id as contact_id,
  d.id as debtor_id,
  c.owner_name,
  c.tenant_name,
  c.apartment_number,
  d.total_debt::float8      as total_debt,
  d.management_fees::float8 as management_fees,
  d.hot_water_debt::float8  as hot_water_debt,
  c.owner_phone  as phone_owner,
  c.tenant_phone as phone_tenant,
  c.owner_is_primary_contact  as owner_primary,
  c.tenant_is_primary_contact as tenant_primary
`;

const CONTACT_FROM = `
  from public.contacts c
  left join public.debtors d on d.contact_id = c.id and d.is_archived = false
`;

// debtor_ids — an explicit pick of debtor records (e.g. from the debtors table),
// so debtors stays the base here; unchanged from before the contacts-first flip.
// rc.id is null only for a debtor whose linked contact was deleted (orphaned via
// debtors_contact_id_fkey's ON DELETE SET NULL) — currently 0 rows in production;
// a guard against deleting a contact with an active debtor is planned separately.
const DEBTOR_COLS = `
  d.id as debtor_id,
  rc.id as contact_id,
  case when rc.id is null then d.owner_name   else rc.owner_name   end as owner_name,
  case when rc.id is null then d.tenant_name  else rc.tenant_name  end as tenant_name,
  d.apartment_number,
  d.total_debt::float8      as total_debt,
  d.management_fees::float8 as management_fees,
  d.hot_water_debt::float8  as hot_water_debt,
  case when rc.id is null then d.phone_owner  else rc.owner_phone  end as phone_owner,
  case when rc.id is null then d.phone_tenant else rc.tenant_phone end as phone_tenant,
  case when rc.id is null then true else rc.owner_is_primary_contact  end as owner_primary,
  case when rc.id is null then true else rc.tenant_is_primary_contact end as tenant_primary
`;

const DEBTOR_FROM = `
  from public.debtors d
  left join public.contacts rc on rc.id = d.contact_id
`;

/** Normalise a debtor phone field to international form, or null. */
function toIntl(field: string | null): string | null {
  const local = cleanPhoneField(field);
  if (!local) return null;
  try {
    return normalizePhone(local).phone;
  } catch {
    return null;
  }
}

/** Which contact_people roles an audience pulls in as extra recipients. */
function extraRoles(audience: BroadcastAudience): ContactPersonRole[] {
  if (audience.type === 'owners') return ['owner'];
  if (audience.type === 'tenants') return ['tenant'];
  return ['owner', 'tenant']; // 'all' / 'debtor_ids'
}

interface AudienceRows {
  rows: ContactRow[];
  extrasByContact: ContactExtraRecipient[];
  extrasByDebtor: ExtraRecipient[];
  /** false only for debtor_ids — an explicit pick skips the opt-out flags. */
  enforcePrimary: boolean;
}

/** The DB fetch shared by resolveBroadcastRecipients (free-form, unchanged)
 *  and resolveConsolidatedBroadcastRecipients (debt messages, PR ב') — same
 *  rows, same extras, same roles/enforcePrimary rule per audience type. Each
 *  caller applies its OWN grouping on top; this only fetches. */
async function fetchAudienceRows(audience: BroadcastAudience): Promise<AudienceRows> {
  const roles = extraRoles(audience);
  const enforcePrimary = audience.type !== 'debtor_ids';
  if (audience.type === 'debtor_ids') {
    const ids = (audience.debtor_ids ?? []).filter((x) => typeof x === 'string');
    if (ids.length === 0) return { rows: [], extrasByContact: [], extrasByDebtor: [], enforcePrimary };
    const r = await query<ContactRow>(
      `select ${DEBTOR_COLS} ${DEBTOR_FROM} where d.id = any($1::uuid[])`,
      [ids],
    );
    const extrasByDebtor = await listExtraRecipientsForDebtors(ids, roles);
    return { rows: r.rows, extrasByContact: [], extrasByDebtor, enforcePrimary };
  }
  const r = await query<ContactRow>(`select ${CONTACT_COLS} ${CONTACT_FROM}`);
  const extrasByContact = await listExtraRecipientsForAllContacts(roles);
  return { rows: r.rows, extrasByContact, extrasByDebtor: [], enforcePrimary };
}

/**
 * Resolve the recipient list for an audience. Picks the matching phone field
 * (owners → phone_owner, tenants → phone_tenant, all/explicit → owner else
 * tenant), keeps only rows with a valid number, and de-dups by phone. The
 * caller snapshots the result into wa_campaign_recipients, so a later audience
 * change never alters an already-started broadcast.
 *
 * On top of that primary phone, every ADDITIONAL owner/tenant on the apartment
 * card (public.contact_people) that is flagged "מקבל הודעות" and carries a valid
 * number becomes its own recipient — same debtor payload, so the template
 * variables ({{debt}}, {{apartment}}, …) interpolate identically. The phone
 * de-dup is global, so a person listed twice is still messaged once. For
 * owners/tenants/all, extras are matched back to their apartment by contact_id
 * (listExtraRecipientsForAllContacts) — an apartment with no debt record gets
 * its additional owners/tenants too, not just its primary one.
 *
 * The primary owner/tenant's own "מקבל הודעות" flag (contacts.owner_is_primary_
 * contact / tenant_is_primary_contact) is honored the same way — EXCEPT for an
 * explicit debtor_ids audience, where a human already hand-picked these exact
 * recipients and silently dropping one would be confusing.
 */
export async function resolveBroadcastRecipients(
  audience: BroadcastAudience,
): Promise<BroadcastRecipient[]> {
  // Extras are matched back to their row by contact_id for owners/tenants/all
  // (contacts is the base — an apartment may have no debtor at all) and by
  // debtor_id for an explicit debtor_ids pick (unchanged — still resolved
  // through debtors.contact_id, per listExtraRecipientsForDebtors).
  const { rows, extrasByContact, extrasByDebtor, enforcePrimary } = await fetchAudienceRows(audience);

  const out: BroadcastRecipient[] = [];
  const seen = new Set<string>();
  const byDebtorId = new Map<string, ContactRow>();
  const byContactId = new Map<string, ContactRow>();
  for (const row of rows) {
    if (row.debtor_id) byDebtorId.set(row.debtor_id, row);
    if (row.contact_id) byContactId.set(row.contact_id, row);
  }

  const push = (row: ContactRow, phoneIntl: string) => {
    // No linked contact (orphaned debtor) — can't form a valid recipient; see
    // the header comment on DEBTOR_COLS.
    if (!row.contact_id) return;
    if (seen.has(phoneIntl)) return;
    seen.add(phoneIntl);
    out.push({
      debtor: {
        owner_name: row.owner_name,
        tenant_name: row.tenant_name,
        apartment_number: row.apartment_number,
        total_debt: row.total_debt,
        management_fees: row.management_fees,
        hot_water_debt: row.hot_water_debt,
      },
      contactId: row.contact_id,
      debtorId: row.debtor_id,
      phoneIntl,
    });
  };

  for (const row of rows) {
    const ownerOk = !enforcePrimary || row.owner_primary;
    const tenantOk = !enforcePrimary || row.tenant_primary;
    let phoneIntl: string | null = null;
    if (audience.type === 'owners') {
      phoneIntl = ownerOk ? toIntl(row.phone_owner) : null;
    } else if (audience.type === 'tenants') {
      phoneIntl = tenantOk ? toIntl(row.phone_tenant) : null;
    } else {
      // 'all' or 'debtor_ids' — prefer owner, fall back to tenant.
      phoneIntl = (ownerOk ? toIntl(row.phone_owner) : null) ?? (tenantOk ? toIntl(row.phone_tenant) : null);
    }
    if (!phoneIntl) continue;
    push(row, phoneIntl);
  }

  // Additional owners/tenants from the apartment card.
  for (const extra of extrasByDebtor) {
    const row = byDebtorId.get(extra.debtor_id);
    if (!row) continue;
    const phoneIntl = toIntl(extra.phone);
    if (!phoneIntl) continue;
    push(row, phoneIntl);
  }
  for (const extra of extrasByContact) {
    const row = byContactId.get(extra.contact_id);
    if (!row) continue;
    const phoneIntl = toIntl(extra.phone);
    if (!phoneIntl) continue;
    push(row, phoneIntl);
  }
  return out;
}

/** One apartment contributing to a consolidated (debt-message) recipient. */
export interface ConsolidatedApartment {
  contactId: string;
  debtorId: string | null;
  apartment_number: string;
  total_debt: number | null;
  management_fees: number | null;
  hot_water_debt: number | null;
}

/** A broadcast recipient consolidated across every apartment sharing one
 *  phone (see resolveConsolidatedBroadcastRecipients). `rawNames` is one
 *  candidate per contributing apartment/extra — resolveConsolidatedName
 *  (whatsapp-template.ts) turns it into the final {{name}}. */
export interface ConsolidatedBroadcastRecipient {
  phoneIntl: string;
  rawNames: Array<string | null | undefined>;
  apartments: ConsolidatedApartment[];
}

/**
 * Debt-message counterpart to resolveBroadcastRecipients: groups by phone
 * INSTEAD of picking one row per phone, so a recipient holding several
 * apartments (or an operator managing dozens) gets ALL of them, not just
 * whichever row happened to be processed first — this is the dedup bug's fix
 * (PR ב'). Reuses the exact same per-row eligibility as resolveBroadcastRecipients
 * (fetchAudienceRows + the identical ownerOk/tenantOk/audience.type branches),
 * so the SET of phones this produces is always identical to
 * resolveBroadcastRecipients' — verified by tests/whatsapp-broadcast-consolidated.test.ts.
 *
 * Apartment-level opt-out: an apartment whose relevant flag
 * (owner_is_primary_contact / tenant_is_primary_contact / contact_people.
 * is_primary_contact for an extra) is off contributes NOTHING to the phone's
 * apartments[] — even when another apartment on the SAME phone passes and the
 * phone still gets a message. This falls out of the per-row/per-extra gate
 * below; there is no separate "apartment opt-out" flag to check.
 */
export async function resolveConsolidatedBroadcastRecipients(
  audience: BroadcastAudience,
): Promise<ConsolidatedBroadcastRecipient[]> {
  const { rows, extrasByContact, extrasByDebtor, enforcePrimary } = await fetchAudienceRows(audience);

  const byDebtorId = new Map<string, ContactRow>();
  const byContactId = new Map<string, ContactRow>();
  for (const row of rows) {
    if (row.debtor_id) byDebtorId.set(row.debtor_id, row);
    if (row.contact_id) byContactId.set(row.contact_id, row);
  }

  const byPhone = new Map<string, { rawNames: Array<string | null | undefined>; apartments: Map<string, ConsolidatedApartment> }>();

  const contribute = (row: ContactRow, phoneIntl: string, name: string | null | undefined) => {
    if (!row.contact_id) return; // orphaned debtor — see DEBTOR_COLS header comment
    let bucket = byPhone.get(phoneIntl);
    if (!bucket) {
      bucket = { rawNames: [], apartments: new Map() };
      byPhone.set(phoneIntl, bucket);
    }
    bucket.rawNames.push(name);
    if (!bucket.apartments.has(row.contact_id)) {
      bucket.apartments.set(row.contact_id, {
        contactId: row.contact_id,
        debtorId: row.debtor_id,
        apartment_number: row.apartment_number,
        total_debt: row.total_debt,
        management_fees: row.management_fees,
        hot_water_debt: row.hot_water_debt,
      });
    }
  };

  for (const row of rows) {
    const ownerOk = !enforcePrimary || row.owner_primary;
    const tenantOk = !enforcePrimary || row.tenant_primary;
    if (audience.type === 'owners') {
      const phoneIntl = ownerOk ? toIntl(row.phone_owner) : null;
      if (phoneIntl) contribute(row, phoneIntl, row.owner_name);
    } else if (audience.type === 'tenants') {
      const phoneIntl = tenantOk ? toIntl(row.phone_tenant) : null;
      if (phoneIntl) contribute(row, phoneIntl, row.tenant_name);
    } else {
      // 'all' or 'debtor_ids' — prefer owner, fall back to tenant; the name
      // candidate follows whichever phone actually won, same as the phone itself.
      const ownerPhone = ownerOk ? toIntl(row.phone_owner) : null;
      if (ownerPhone) {
        contribute(row, ownerPhone, row.owner_name);
      } else {
        const tenantPhone = tenantOk ? toIntl(row.phone_tenant) : null;
        if (tenantPhone) contribute(row, tenantPhone, row.tenant_name);
      }
    }
  }

  // Additional owners/tenants from the apartment card — each is its own name
  // candidate, tied to the SAME apartment as the row it's matched back to.
  for (const extra of extrasByDebtor) {
    const row = byDebtorId.get(extra.debtor_id);
    if (!row) continue;
    const phoneIntl = toIntl(extra.phone);
    if (!phoneIntl) continue;
    contribute(row, phoneIntl, extra.name);
  }
  for (const extra of extrasByContact) {
    const row = byContactId.get(extra.contact_id);
    if (!row) continue;
    const phoneIntl = toIntl(extra.phone);
    if (!phoneIntl) continue;
    contribute(row, phoneIntl, extra.name);
  }

  return Array.from(byPhone.entries()).map(([phoneIntl, bucket]) => ({
    phoneIntl,
    rawNames: bucket.rawNames,
    apartments: Array.from(bucket.apartments.values()),
  }));
}

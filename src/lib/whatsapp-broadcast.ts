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
import type {
  BroadcastAudience, BroadcastDebtFilter, BroadcastRoleSelection, MissingEmailEntry,
} from '@/types/whatsapp';
import type { ContactPersonRole } from '@/lib/types/contacts';
import { isValidMinDebtAmount, MIN_DEBT_AMOUNT_ERROR } from '@/lib/whatsapp-audience-filter';
import { EMAIL_RE } from '@/lib/validation/contacts';

// Audience → recipient resolution for broadcasts. The actual sending is the
// durable delivery queue's job (src/lib/wa-queue/*, drained by the standalone
// worker). For owners/tenants/all, this module resolves recipients from
// `contacts` (the apartment registry — every apartment, debt or not), LEFT
// JOINing the active debtor when one exists; an apartment with no debt record
// still gets its owner/tenant recipients, just with zero-valued debt template
// fields. The campaigns route (POST /api/whatsapp/campaigns) and the live
// estimate (POST /api/whatsapp/audience-count) both call it; the estimate also
// calls resolveConsolidatedBroadcastRecipients (below) for a debt message.
//
// Two channels, one audience logic (09/10/2026): the same rows, "מקבל הודעות"
// flags, debt filter and union/consolidation decide who is in the audience;
// only the ADDRESS differs — a mobile phone for WhatsApp (toIntl), an email
// address for the email channel (toEmail). Every loop is written once against
// an Addressing; the WhatsApp exports return exactly the shapes they always did.

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
  /** The person behind the address — the owner's or tenant's name on the card,
   *  or an additional person's (contact_people.name); null when the card holds
   *  none. Snapshotted as wa_campaign_recipients.recipient_name. */
  name: string | null;
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
  owner_email: string | null;
  tenant_email: string | null;
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
  c.owner_email,
  c.tenant_email,
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
  rc.owner_email,
  rc.tenant_email,
  case when rc.id is null then true else rc.owner_is_primary_contact  end as owner_primary,
  case when rc.id is null then true else rc.tenant_is_primary_contact end as tenant_primary
`;

const DEBTOR_FROM = `
  from public.debtors d
  left join public.contacts rc on rc.id = d.contact_id
`;

/** Normalise a phone field to international form, or null when it can't
 *  receive a WhatsApp message: unparseable, OR a landline. normalizePhone
 *  accepts both IL shapes — mobile (972 + 9 digits, 12 chars) and landline
 *  (972 + 8 digits, 11 chars) — but a landline has no WhatsApp account and
 *  would only fail at Green API send time, so the broadcast path filters it
 *  out here (Section 6). Every resolver below goes through this one gate, so
 *  the audience count only ever includes phones that will actually receive. */
function toIntl(field: string | null): string | null {
  const local = cleanPhoneField(field);
  if (!local) return null;
  try {
    const intl = normalizePhone(local).phone;
    return intl.length === 12 ? intl : null;
  } catch {
    return null;
  }
}

/** The email channel's one gate: a single well-formed address (the shape the
 *  contact card itself enforces), lower-cased so one mailbox is one recipient
 *  however it was typed. Anything else = no email. */
export function toEmail(field: string | null | undefined): string | null {
  const v = (field ?? '').trim().toLowerCase();
  return v && EMAIL_RE.test(v) ? v : null;
}

interface SupplierRow {
  id: string;
  display_name: string;
  phone: string | null;
  mobile: string | null;
  email: string | null;
}

/** How a channel reaches each kind of person — the address it sends to, or
 *  null when that person cannot receive on it. */
interface Addressing {
  /** Which extra people the fetch must keep: WhatsApp only ever wants those
   *  with a phone; email judges every opted-in person's own address. */
  extrasRequire: 'phone' | 'any';
  owner(row: ContactRow): string | null;
  tenant(row: ContactRow): string | null;
  extra(extra: { phone: string | null; email?: string | null }): string | null;
  supplier(row: SupplierRow): string | null;
}

/** WhatsApp: mobiles only; a supplier's mobile first, then its phone (same
 *  rule as getSupplierNotifyContact in src/lib/db/suppliers.ts). */
const BY_PHONE: Addressing = {
  extrasRequire: 'phone',
  owner: (row) => toIntl(row.phone_owner),
  tenant: (row) => toIntl(row.phone_tenant),
  extra: (extra) => toIntl(extra.phone),
  supplier: (row) => toIntl(row.mobile) ?? toIntl(row.phone),
};

/** Email: the owner/tenant email fields of the apartment card, the extra
 *  person's own email, the supplier's email. */
const BY_EMAIL: Addressing = {
  extrasRequire: 'any',
  owner: (row) => toEmail(row.owner_email),
  tenant: (row) => toEmail(row.tenant_email),
  extra: (extra) => toEmail(extra.email),
  supplier: (row) => toEmail(row.email),
};

export type ParsedBroadcastDebtFilter =
  | { ok: true; value: BroadcastDebtFilter | undefined }
  | { ok: false; error: string };

/** Parses a request body's `debt_filter` field into a BroadcastDebtFilter —
 *  shared by the campaign-create and audience-count routes so the two never
 *  drift. Absent/not-an-object/only_with_debt !== true all mean "no filter"
 *  (`ok: true, value: undefined`) — those aren't errors, since the field is
 *  simply off. Once only_with_debt is true, though, a min_debt_amount that IS
 *  given must be a valid non-negative finite number (isValidMinDebtAmount,
 *  the SAME rule the compose screen checks inline before ever sending), or a
 *  negative/non-numeric amount would otherwise silently filter on the wrong
 *  threshold — `ok: false` with the shared 400-ready Hebrew message. Omitted/
 *  null is valid and means "any positive debt" (min_debt_amount: null). */
export function parseBroadcastDebtFilter(raw: unknown): ParsedBroadcastDebtFilter {
  if (typeof raw !== 'object' || raw === null) return { ok: true, value: undefined };
  const d = raw as Record<string, unknown>;
  if (d.only_with_debt !== true) return { ok: true, value: undefined };
  const amount = d.min_debt_amount ?? null;
  if (!isValidMinDebtAmount(amount)) return { ok: false, error: MIN_DEBT_AMOUNT_ERROR };
  return { ok: true, value: { only_with_debt: true, min_debt_amount: amount } };
}

/** true when a row's total_debt clears the audience's debt filter (or there
 *  is no filter at all). A row with no debtor (total_debt null) counts as 0
 *  — it never "owes" anything. The comparison is strict ("מעל" = above), so
 *  an omitted amount (→ threshold 0) means "any positive debt". */
function passesDebtFilter(totalDebt: number | null, filter: BroadcastDebtFilter | undefined): boolean {
  if (!filter?.only_with_debt) return true;
  const debt = totalDebt ?? 0;
  const threshold = filter.min_debt_amount ?? 0;
  return debt > threshold;
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

/** The DB fetch shared by every resolver — same rows, same extras, same
 *  roles/enforcePrimary rule per audience type. Each caller applies its OWN
 *  grouping on top; this only fetches. `extrasRequire: 'any'` (the email
 *  channel) also returns extra people without a phone. */
async function fetchAudienceRows(
  audience: BroadcastAudience,
  extrasRequire: 'phone' | 'any' = 'phone',
): Promise<AudienceRows> {
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
  const extrasByContact = await listExtraRecipientsForAllContacts(roles, extrasRequire);
  return { rows: r.rows, extrasByContact, extrasByDebtor: [], enforcePrimary };
}

/** A recipient before the channel names its address field. */
interface AddressedRecipient {
  debtor: TemplateDebtor;
  contactId: string;
  debtorId: string | null;
  address: string;
  /** The person behind the address (see BroadcastRecipient.name). */
  name: string | null;
}

/** The address an audience row is reached at — owners → the owner's, tenants
 *  → the tenant's, all/explicit → owner else tenant — honouring the "מקבל
 *  הודעות" flags. `name` is the candidate for {{name}} of the address that won. */
function pickRowAddress(
  audience: BroadcastAudience,
  row: ContactRow,
  enforcePrimary: boolean,
  addr: Addressing,
): { address: string; name: string | null } | null {
  const ownerOk = !enforcePrimary || row.owner_primary;
  const tenantOk = !enforcePrimary || row.tenant_primary;
  if (audience.type === 'owners') {
    const address = ownerOk ? addr.owner(row) : null;
    return address ? { address, name: row.owner_name } : null;
  }
  if (audience.type === 'tenants') {
    const address = tenantOk ? addr.tenant(row) : null;
    return address ? { address, name: row.tenant_name } : null;
  }
  // 'all' or 'debtor_ids' — prefer owner, fall back to tenant; the name
  // candidate follows whichever address actually won.
  const owner = ownerOk ? addr.owner(row) : null;
  if (owner) return { address: owner, name: row.owner_name };
  const tenant = tenantOk ? addr.tenant(row) : null;
  return tenant ? { address: tenant, name: row.tenant_name } : null;
}

/**
 * Resolve the recipient list for an audience. Picks the matching address
 * (owners → owner, tenants → tenant, all/explicit → owner else tenant), keeps
 * only rows with a valid one, and de-dups by address. The caller snapshots the
 * result into wa_campaign_recipients, so a later audience change never alters
 * an already-started broadcast.
 *
 * On top of that primary address, every ADDITIONAL owner/tenant on the
 * apartment card (public.contact_people) that is flagged "מקבל הודעות" and
 * carries a valid address becomes its own recipient — same debtor payload, so
 * the template variables ({{debt}}, {{apartment}}, …) interpolate identically.
 * The de-dup is global, so a person listed twice is still messaged once. For
 * owners/tenants/all, extras are matched back to their apartment by contact_id
 * (listExtraRecipientsForAllContacts) — an apartment with no debt record gets
 * its additional owners/tenants too, not just its primary one.
 *
 * The primary owner/tenant's own "מקבל הודעות" flag (contacts.owner_is_primary_
 * contact / tenant_is_primary_contact) is honored the same way — EXCEPT for an
 * explicit debtor_ids audience, where a human already hand-picked these exact
 * recipients and silently dropping one would be confusing.
 *
 * `debtFilter` (Section 4) drops a row — and every extra tied to it — BEFORE
 * the owner/tenant address is even picked, when its total_debt doesn't clear
 * the filter. Undefined/off is a no-op, so every existing caller is unaffected.
 */
async function collectRecipients(
  audience: BroadcastAudience,
  debtFilter: BroadcastDebtFilter | undefined,
  addr: Addressing,
): Promise<AddressedRecipient[]> {
  // Extras are matched back to their row by contact_id for owners/tenants/all
  // (contacts is the base — an apartment may have no debtor at all) and by
  // debtor_id for an explicit debtor_ids pick (unchanged — still resolved
  // through debtors.contact_id, per listExtraRecipientsForDebtors).
  const { rows, extrasByContact, extrasByDebtor, enforcePrimary } = await fetchAudienceRows(audience, addr.extrasRequire);

  const out: AddressedRecipient[] = [];
  const seen = new Set<string>();
  const byDebtorId = new Map<string, ContactRow>();
  const byContactId = new Map<string, ContactRow>();
  for (const row of rows) {
    if (row.debtor_id) byDebtorId.set(row.debtor_id, row);
    if (row.contact_id) byContactId.set(row.contact_id, row);
  }

  const push = (row: ContactRow, address: string, name: string | null | undefined) => {
    // No linked contact (orphaned debtor) — can't form a valid recipient; see
    // the header comment on DEBTOR_COLS.
    if (!row.contact_id) return;
    if (seen.has(address)) return;
    seen.add(address);
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
      address,
      name: name ?? null,
    });
  };

  for (const row of rows) {
    if (!passesDebtFilter(row.total_debt, debtFilter)) continue;
    const picked = pickRowAddress(audience, row, enforcePrimary, addr);
    if (picked) push(row, picked.address, picked.name);
  }

  // Additional owners/tenants from the apartment card — same debt filter as
  // their apartment's own row (the debt is a property of the apartment, not
  // of who's receiving the message on its behalf).
  for (const extra of extrasByDebtor) {
    const row = byDebtorId.get(extra.debtor_id);
    if (!row || !passesDebtFilter(row.total_debt, debtFilter)) continue;
    const address = addr.extra(extra);
    if (address) push(row, address, extra.name);
  }
  for (const extra of extrasByContact) {
    const row = byContactId.get(extra.contact_id);
    if (!row || !passesDebtFilter(row.total_debt, debtFilter)) continue;
    const address = addr.extra(extra);
    if (address) push(row, address, extra.name);
  }
  return out;
}

function asPhoneRecipient(r: AddressedRecipient): BroadcastRecipient {
  return { debtor: r.debtor, contactId: r.contactId, debtorId: r.debtorId, phoneIntl: r.address, name: r.name };
}

/** WhatsApp — see collectRecipients. */
export async function resolveBroadcastRecipients(
  audience: BroadcastAudience,
  debtFilter?: BroadcastDebtFilter,
): Promise<BroadcastRecipient[]> {
  return (await collectRecipients(audience, debtFilter, BY_PHONE)).map(asPhoneRecipient);
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

/** The same, before the channel names its address field. */
interface ConsolidatedAddressed {
  address: string;
  rawNames: Array<string | null | undefined>;
  apartments: ConsolidatedApartment[];
}

type ConsolidationBuckets = Map<string, { rawNames: Array<string | null | undefined>; apartments: Map<string, ConsolidatedApartment> }>;

function bucketsToList(byAddress: ConsolidationBuckets): ConsolidatedAddressed[] {
  return Array.from(byAddress.entries()).map(([address, bucket]) => ({
    address,
    rawNames: bucket.rawNames,
    apartments: Array.from(bucket.apartments.values()),
  }));
}

/**
 * Debt-message counterpart to collectRecipients: groups by address INSTEAD of
 * picking one row per address, so a recipient holding several apartments (or
 * an operator managing dozens) gets ALL of them, not just whichever row
 * happened to be processed first — this is the dedup bug's fix (PR ב').
 * Reuses the exact same per-row eligibility (fetchAudienceRows +
 * pickRowAddress), so the SET of addresses this produces is always identical
 * to collectRecipients' — verified by tests/whatsapp-broadcast-consolidated.test.ts.
 *
 * Apartment-level opt-out: an apartment whose relevant flag
 * (owner_is_primary_contact / tenant_is_primary_contact / contact_people.
 * is_primary_contact for an extra) is off contributes NOTHING to the address's
 * apartments[] — even when another apartment on the SAME address passes and
 * still gets a message. This falls out of the per-row/per-extra gate below;
 * there is no separate "apartment opt-out" flag to check.
 *
 * `debtFilter` (Section 4) gates the SAME way, per apartment: a row whose
 * total_debt doesn't clear the filter contributes nothing at all — so a
 * failing apartment never appears in ANY address's apartments[] (the
 * consolidated message's detail only ever lists apartments that passed),
 * while an address whose every apartment fails simply never enters the map.
 */
async function collectConsolidated(
  audience: BroadcastAudience,
  debtFilter: BroadcastDebtFilter | undefined,
  addr: Addressing,
): Promise<ConsolidatedAddressed[]> {
  const { rows, extrasByContact, extrasByDebtor, enforcePrimary } = await fetchAudienceRows(audience, addr.extrasRequire);

  const byDebtorId = new Map<string, ContactRow>();
  const byContactId = new Map<string, ContactRow>();
  for (const row of rows) {
    if (row.debtor_id) byDebtorId.set(row.debtor_id, row);
    if (row.contact_id) byContactId.set(row.contact_id, row);
  }

  const byAddress: ConsolidationBuckets = new Map();

  const contribute = (row: ContactRow, address: string, name: string | null | undefined) => {
    if (!row.contact_id) return; // orphaned debtor — see DEBTOR_COLS header comment
    let bucket = byAddress.get(address);
    if (!bucket) {
      bucket = { rawNames: [], apartments: new Map() };
      byAddress.set(address, bucket);
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
    if (!passesDebtFilter(row.total_debt, debtFilter)) continue;
    const picked = pickRowAddress(audience, row, enforcePrimary, addr);
    if (picked) contribute(row, picked.address, picked.name);
  }

  // Additional owners/tenants from the apartment card — each is its own name
  // candidate, tied to the SAME apartment as the row it's matched back to
  // (and gated by that SAME apartment's debt filter, not the extra person's).
  for (const extra of extrasByDebtor) {
    const row = byDebtorId.get(extra.debtor_id);
    if (!row || !passesDebtFilter(row.total_debt, debtFilter)) continue;
    const address = addr.extra(extra);
    if (address) contribute(row, address, extra.name);
  }
  for (const extra of extrasByContact) {
    const row = byContactId.get(extra.contact_id);
    if (!row || !passesDebtFilter(row.total_debt, debtFilter)) continue;
    const address = addr.extra(extra);
    if (address) contribute(row, address, extra.name);
  }

  return bucketsToList(byAddress);
}

function asPhoneConsolidated(r: ConsolidatedAddressed): ConsolidatedBroadcastRecipient {
  return { phoneIntl: r.address, rawNames: r.rawNames, apartments: r.apartments };
}

/** WhatsApp — see collectConsolidated. */
export async function resolveConsolidatedBroadcastRecipients(
  audience: BroadcastAudience,
  debtFilter?: BroadcastDebtFilter,
): Promise<ConsolidatedBroadcastRecipient[]> {
  return (await collectConsolidated(audience, debtFilter, BY_PHONE)).map(asPhoneConsolidated);
}

// ── Multi-select audience (owners/tenants/suppliers checkboxes) ────────────
// The compose screen's "selection" audience is a TRUE UNION of the checked
// roles: an apartment with both an eligible owner address and an eligible
// tenant address gets two separate messages when both boxes are checked
// (deliberately different from "all"'s single-recipient-per-apartment,
// owner-preferred behavior, which stays untouched for any caller still using
// it directly). An address reached by more than one role is only ever messaged
// ONCE — the union dedups globally by address, contacts (owners/tenants) always
// winning identity over a supplier on the same address.

export interface SupplierRecipient {
  supplierId: string;
  phoneIntl: string;
  name: string | null;
}

async function activeSuppliers(): Promise<SupplierRow[]> {
  const r = await query<SupplierRow>(
    `select id, display_name, phone, mobile, email from public.suppliers
      where status = 'active' and deleted_at is null`,
  );
  return r.rows;
}

/** Active, non-deleted suppliers with a valid address on the channel.
 *  Suppliers carry no apartment/debt data at all — never eligible for a
 *  debt-message template; the campaigns route blocks that combination
 *  outright at creation time. */
async function collectSuppliers(addr: Addressing): Promise<Array<{ supplierId: string; address: string; name: string | null }>> {
  const out: Array<{ supplierId: string; address: string; name: string | null }> = [];
  const seen = new Set<string>();
  for (const row of await activeSuppliers()) {
    const address = addr.supplier(row);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ supplierId: row.id, address, name: row.display_name || null });
  }
  return out;
}

/** WhatsApp — mobile preferred, phone as fallback. */
export async function resolveSupplierRecipients(): Promise<SupplierRecipient[]> {
  return (await collectSuppliers(BY_PHONE)).map((s) => ({ supplierId: s.supplierId, phoneIntl: s.address, name: s.name }));
}

function unionByAddress(lists: ReadonlyArray<AddressedRecipient[]>): AddressedRecipient[] {
  const byAddress = new Map<string, AddressedRecipient>();
  for (const list of lists) for (const r of list) if (!byAddress.has(r.address)) byAddress.set(r.address, r);
  return Array.from(byAddress.values());
}

function unionConsolidatedByAddress(lists: ReadonlyArray<ConsolidatedAddressed[]>): ConsolidatedAddressed[] {
  const byAddress: ConsolidationBuckets = new Map();
  for (const list of lists) {
    for (const r of list) {
      let bucket = byAddress.get(r.address);
      if (!bucket) { bucket = { rawNames: [], apartments: new Map() }; byAddress.set(r.address, bucket); }
      bucket.rawNames.push(...r.rawNames);
      for (const apt of r.apartments) if (!bucket.apartments.has(apt.contactId)) bucket.apartments.set(apt.contactId, apt);
    }
  }
  return bucketsToList(byAddress);
}

/** A "selection" audience recipient — a resident (apartment-backed, same
 *  shape as the free-form path today) or a supplier (no apartment/debt at
 *  all; {{name}} is the supplier's display_name, every debt/apartment token
 *  renders blank/₪0 via the same defensive TemplateDebtor defaults —
 *  unreachable in practice since a debt template can't target suppliers). */
export type SelectionRecipient =
  | { kind: 'contact'; contactId: string; debtorId: string | null; debtor: TemplateDebtor; phoneIntl: string; name: string | null }
  | { kind: 'supplier'; supplierId: string; name: string | null; phoneIntl: string };

type AddressedSelection =
  | { kind: 'contact'; contactId: string; debtorId: string | null; debtor: TemplateDebtor; address: string; name: string | null }
  | { kind: 'supplier'; supplierId: string; name: string | null; address: string };

/** Free-form path for a multi-select audience — union of collectRecipients
 *  per checked role (owners/tenants, each unchanged) plus the suppliers when
 *  'suppliers' is checked. `debtFilter` (Section 4) is forwarded to the
 *  owners/tenants calls only — suppliers carry no debt data and are never
 *  filtered by it, regardless of whether 'suppliers' is also checked. */
async function collectSelection(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter: BroadcastDebtFilter | undefined,
  addr: Addressing,
): Promise<AddressedSelection[]> {
  const lists: AddressedRecipient[][] = [];
  if (roles.includes('owners')) lists.push(await collectRecipients({ type: 'owners' }, debtFilter, addr));
  if (roles.includes('tenants')) lists.push(await collectRecipients({ type: 'tenants' }, debtFilter, addr));
  const contacts: AddressedSelection[] = unionByAddress(lists).map((r) => ({
    kind: 'contact', contactId: r.contactId, debtorId: r.debtorId, debtor: r.debtor, address: r.address, name: r.name,
  }));

  const out: AddressedSelection[] = [...contacts];
  if (roles.includes('suppliers')) {
    const seen = new Set(contacts.map((c) => c.address));
    for (const s of await collectSuppliers(addr)) {
      if (seen.has(s.address)) continue; // a resident's identity on this address wins
      seen.add(s.address);
      out.push({ kind: 'supplier', supplierId: s.supplierId, name: s.name, address: s.address });
    }
  }
  return out;
}

/** WhatsApp — see collectSelection. */
export async function resolveSelectionRecipients(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter?: BroadcastDebtFilter,
): Promise<SelectionRecipient[]> {
  return (await collectSelection(roles, debtFilter, BY_PHONE)).map((r) => (r.kind === 'supplier'
    ? { kind: 'supplier', supplierId: r.supplierId, name: r.name, phoneIntl: r.address }
    : { kind: 'contact', contactId: r.contactId, debtorId: r.debtorId, debtor: r.debtor, phoneIntl: r.address, name: r.name }));
}

/** Debt-message (consolidated) path for a multi-select audience. Suppliers are
 *  never included here — the campaigns route blocks a debt template + a
 *  supplier-including selection outright before this would ever be called.
 *  `debtFilter` (Section 4) is forwarded to both role calls. */
async function collectConsolidatedSelection(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter: BroadcastDebtFilter | undefined,
  addr: Addressing,
): Promise<ConsolidatedAddressed[]> {
  const lists: ConsolidatedAddressed[][] = [];
  if (roles.includes('owners')) lists.push(await collectConsolidated({ type: 'owners' }, debtFilter, addr));
  if (roles.includes('tenants')) lists.push(await collectConsolidated({ type: 'tenants' }, debtFilter, addr));
  return unionConsolidatedByAddress(lists);
}

/** WhatsApp — see collectConsolidatedSelection. */
export async function resolveConsolidatedSelectionRecipients(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter?: BroadcastDebtFilter,
): Promise<ConsolidatedBroadcastRecipient[]> {
  return (await collectConsolidatedSelection(roles, debtFilter, BY_PHONE)).map(asPhoneConsolidated);
}

// ── Email channel (09/10/2026) ──────────────────────────────────────────────
// The compose screen's "selection" audience, reached by email: the same union,
// flags and debt filter as WhatsApp, an email address instead of a phone, plus
// the list of who in that audience has no usable address (shown before
// sending — "X עם אימייל / Y ללא").

export type EmailSelectionRecipient =
  | { kind: 'contact'; contactId: string; debtorId: string | null; debtor: TemplateDebtor; email: string; name: string | null }
  | { kind: 'supplier'; supplierId: string; name: string | null; email: string };

export interface ConsolidatedEmailRecipient {
  email: string;
  rawNames: Array<string | null | undefined>;
  apartments: ConsolidatedApartment[];
}

/** Free-form email broadcast: one email per address. */
export async function resolveEmailSelectionRecipients(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter?: BroadcastDebtFilter,
): Promise<EmailSelectionRecipient[]> {
  return (await collectSelection(roles, debtFilter, BY_EMAIL)).map((r) => (r.kind === 'supplier'
    ? { kind: 'supplier', supplierId: r.supplierId, name: r.name, email: r.address }
    : { kind: 'contact', contactId: r.contactId, debtorId: r.debtorId, debtor: r.debtor, email: r.address, name: r.name }));
}

/** Debt-message email broadcast: one email per address, every apartment of it. */
export async function resolveConsolidatedEmailSelectionRecipients(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter?: BroadcastDebtFilter,
): Promise<ConsolidatedEmailRecipient[]> {
  return (await collectConsolidatedSelection(roles, debtFilter, BY_EMAIL))
    .map((r) => ({ email: r.address, rawNames: r.rawNames, apartments: r.apartments }));
}

function hasText(v: string | null | undefined): boolean {
  return (v ?? '').trim() !== '';
}

/**
 * Who in a "selection" audience the email channel cannot reach — the same
 * people the WhatsApp channel would consider (opted-in owners/tenants of the
 * apartments that pass the debt filter, their opted-in additional people, the
 * active suppliers), minus everyone with a usable address. A primary slot
 * counts as a person only when the card holds something for it (a name, a
 * phone or an email) — an apartment without a tenant is not "a tenant without
 * an email". Ordered by apartment, owners before tenants, suppliers last.
 */
export async function listSelectionMissingEmail(
  roles: ReadonlyArray<BroadcastRoleSelection>,
  debtFilter?: BroadcastDebtFilter,
): Promise<MissingEmailEntry[]> {
  const out: MissingEmailEntry[] = [];
  const slots: Array<{ type: 'owners' | 'tenants'; role: 'owner' | 'tenant' }> = [];
  if (roles.includes('owners')) slots.push({ type: 'owners', role: 'owner' });
  if (roles.includes('tenants')) slots.push({ type: 'tenants', role: 'tenant' });

  for (const { type, role } of slots) {
    const { rows, extrasByContact } = await fetchAudienceRows({ type }, BY_EMAIL.extrasRequire);
    const byContactId = new Map<string, ContactRow>();
    for (const row of rows) {
      if (row.contact_id) byContactId.set(row.contact_id, row);
      if (!passesDebtFilter(row.total_debt, debtFilter)) continue;
      const optedIn = role === 'owner' ? row.owner_primary : row.tenant_primary;
      const name = role === 'owner' ? row.owner_name : row.tenant_name;
      const phone = role === 'owner' ? row.phone_owner : row.phone_tenant;
      const email = role === 'owner' ? row.owner_email : row.tenant_email;
      if (!optedIn || !(hasText(name) || hasText(phone) || hasText(email))) continue;
      if (!(role === 'owner' ? BY_EMAIL.owner(row) : BY_EMAIL.tenant(row))) {
        out.push({ role, apartment_number: row.apartment_number, name: hasText(name) ? name!.trim() : null });
      }
    }
    for (const extra of extrasByContact) {
      const row = byContactId.get(extra.contact_id);
      if (!row || !passesDebtFilter(row.total_debt, debtFilter)) continue;
      if (!BY_EMAIL.extra(extra)) {
        out.push({ role, apartment_number: row.apartment_number, name: hasText(extra.name) ? extra.name!.trim() : null });
      }
    }
  }

  out.sort((a, b) => {
    const na = Number(a.apartment_number);
    const nb = Number(b.apartment_number);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (a.apartment_number !== b.apartment_number) return String(a.apartment_number).localeCompare(String(b.apartment_number));
    return a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1;
  });

  if (roles.includes('suppliers')) {
    for (const row of await activeSuppliers()) {
      if (!BY_EMAIL.supplier(row)) out.push({ role: 'supplier', apartment_number: null, name: row.display_name || null });
    }
  }
  return out;
}

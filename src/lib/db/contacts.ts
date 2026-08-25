import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  Contact,
  ContactListFilters,
  ContactWritableFields,
} from '@/lib/types/contacts';
import type { ContactResidentCard, ContactResidents } from '@/lib/types/chips';

/** Thrown when an insert/upsert collides with an existing apartment_number. */
export class ConflictError extends Error {
  constructor(message = 'apartment_number_exists') {
    super(message);
    this.name = 'ConflictError';
  }
}

// The extra owners/tenants of a contact, aggregated inline so every read path
// returns them in ONE query (no N+1). Correlates on the alias `contacts`, which
// is the table's own name in every statement below — including RETURNING.
const PEOPLE_JSON = `
  coalesce((
    select json_agg(json_build_object(
      'id', p.id, 'role', p.role, 'name', p.name, 'phone', p.phone,
      'email', p.email, 'is_primary_contact', p.is_primary_contact,
      'sort_order', p.sort_order
    ) order by p.role, p.sort_order, p.created_at)
    from public.contact_people p where p.contact_id = contacts.id
  ), '[]'::json) as people`;

const CONTACT_COLUMNS = `
  id, apartment_number, owner_name, owner_phone, owner_email,
  tenant_name, tenant_phone, tenant_email, operator_name, operator_phone,
  resident_type, unit_type, needs_review, operator_id,
  owner_is_primary_contact, tenant_is_primary_contact, operator_is_primary_contact,
  address, notes, tags, whatsapp_profile_image_url, whatsapp_profile_sync_status,
  whatsapp_profile_last_synced_at, whatsapp_profile_sync_error,
  last_whatsapp_sent_at, last_synced_at, created_at, updated_at, created_by,
  apartment_size_sqm::float8 as apartment_size_sqm,
  management_fee::float8     as management_fee,
  ${PEOPLE_JSON}`;

// Writable columns (excludes apartment_number, which is keyed/immutable, plus
// the server-managed id/timestamps/created_by). Order is irrelevant.
const WRITABLE_COLUMNS = [
  'apartment_size_sqm', 'management_fee',
  'owner_name', 'owner_phone', 'owner_email',
  'tenant_name', 'tenant_phone', 'tenant_email',
  'operator_name', 'operator_phone',
  'resident_type', 'unit_type', 'operator_id',
  'owner_is_primary_contact', 'tenant_is_primary_contact', 'operator_is_primary_contact',
  'address', 'notes', 'tags',
  'whatsapp_profile_image_url', 'whatsapp_profile_sync_status',
  'whatsapp_profile_last_synced_at', 'whatsapp_profile_sync_error',
  'last_whatsapp_sent_at', 'last_synced_at',
] as const;

// SQL expression that reduces an apartment_number to its canonical key:
// strip non-digits, strip leading zeros, '' → '0'. Mirrors normalizeApartmentNumber.
const APT_KEY_SQL = (col: string) =>
  `coalesce(nullif(regexp_replace(regexp_replace(${col}, '\\D', '', 'g'), '^0+', ''), ''), '0')`;

/**
 * Canonical apartment key: trim, strip non-digits, strip leading zeros,
 * '' → '0'. Two raw values that name the same apartment collapse to one key,
 * which is what the UNIQUE constraint dedupes on.
 */
function normalizeApartmentNumber(raw: string): string {
  const digits = (raw ?? '').trim().replace(/\D/g, '').replace(/^0+/, '');
  return digits === '' ? '0' : digits;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function listContacts(filters: ContactListFilters = {}): Promise<Contact[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(
      `(apartment_number ilike ${p} or owner_name ilike ${p} or owner_phone ilike ${p}
        or tenant_name ilike ${p} or tenant_phone ilike ${p})`,
    );
  }

  if (filters.tags && filters.tags.length > 0) {
    // every-semantics: a contact must carry ALL requested tags.
    params.push(filters.tags);
    where.push(`tags @> $${params.length}::text[]`);
  }

  let orderBy: string;
  switch (filters.sort) {
    case 'apartment_desc':
      orderBy = `nullif(regexp_replace(apartment_number, '\\D', '', 'g'), '')::int desc nulls last, apartment_number desc`;
      break;
    case 'updated_desc':
      orderBy = `updated_at desc`;
      break;
    case 'created_desc':
      orderBy = `created_at desc`;
      break;
    case 'apartment_asc':
    default:
      orderBy = `nullif(regexp_replace(apartment_number, '\\D', '', 'g'), '')::int asc nulls last, apartment_number asc`;
      break;
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<Contact>(
    `select ${CONTACT_COLUMNS} from public.contacts ${whereSql} order by ${orderBy}`,
    params,
  );
  return r.rows;
}

/**
 * Just the apartment numbers, in the table's natural order (numeric ascending,
 * anything non-numeric last). The /parking table needs one row per apartment
 * and nothing else about it — loading full contact rows there would drag along
 * every phone number and person for a screen that shows none of them.
 */
export async function listApartmentNumbers(): Promise<string[]> {
  const r = await query<{ apartment_number: string }>(
    `select apartment_number from public.contacts
      order by nullif(regexp_replace(apartment_number, '\\D', '', 'g'), '')::int asc nulls last,
               apartment_number asc`,
  );
  return r.rows.map((row) => row.apartment_number);
}

export async function getContactById(id: string): Promise<Contact | null> {
  return queryOne<Contact>(
    `select ${CONTACT_COLUMNS} from public.contacts where id = $1`,
    [id],
  );
}

// ── Writes ───────────────────────────────────────────────────────────────

export async function createContact(
  data: Partial<ContactWritableFields> & { apartment_number: string },
  createdBy: string | null,
): Promise<Contact> {
  const rec = data as Record<string, unknown>;
  // source is a SERVER-side stamp — not client-writable (coerceContactInput
  // never emits it). Direct creates default to 'manual'; internal callers may
  // pass their own (e.g. a sync), which wins.
  const source =
    typeof rec.source === 'string' && rec.source.trim() !== '' ? rec.source : 'manual';
  const cols: string[] = ['apartment_number', 'created_by', 'source'];
  const vals: unknown[] = [
    normalizeApartmentNumber(data.apartment_number ?? ''), createdBy, source,
  ];

  for (const c of WRITABLE_COLUMNS) {
    if (c in rec && rec[c] !== undefined) {
      cols.push(c);
      vals.push(rec[c]);
    }
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`);
  try {
    const row = await queryOne<Contact>(
      `insert into public.contacts (${cols.join(', ')})
       values (${placeholders.join(', ')})
       returning ${CONTACT_COLUMNS}`,
      vals,
    );
    if (!row) throw new Error('failed_to_create_contact');
    return row;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError();
    }
    throw err;
  }
}

/**
 * Partial update. apartment_number is immutable — stripped before the SQL. If
 * nothing remains to update, returns the current row unchanged. Returns null
 * if the id does not exist.
 */
export async function updateContact(
  id: string,
  data: Partial<ContactWritableFields>,
): Promise<Contact | null> {
  const rec = { ...data } as Record<string, unknown>;
  delete rec.apartment_number; // immutable

  const set: string[] = [];
  const vals: unknown[] = [id];
  for (const c of WRITABLE_COLUMNS) {
    if (c in rec && rec[c] !== undefined) {
      vals.push(rec[c]);
      set.push(`${c} = $${vals.length}`);
    }
  }

  if (set.length === 0) {
    // Nothing writable supplied — skip the UPDATE, return the row as-is.
    return getContactById(id);
  }

  return queryOne<Contact>(
    `update public.contacts set ${set.join(', ')} where id = $1 returning ${CONTACT_COLUMNS}`,
    vals,
  );
}

export async function deleteContact(id: string): Promise<boolean> {
  const r = await query(`delete from public.contacts where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

// ── Sync helpers (Track B consumes these) ─────────────────────────────────

export interface UpsertContactOpts {
  /** When true, manual fields with an existing NOT-NULL value are preserved. */
  protectManualFields?: boolean;
  /** Stamped onto created_by when the row is first inserted. */
  createdBy?: string | null;
  /**
   * Whitelist of writable columns the upsert may touch. When provided, any
   * column NOT in this list is dropped from the payload entirely — neither
   * inserted nor updated (apartment_number/last_synced_at are always managed).
   * Lets a sync (Track B) declare exactly which fields it owns so it can never
   * clobber a column it never meant to write.
   */
  allowedFields?: string[];
}

/**
 * Normalize an incoming upsert value: blank/whitespace-only strings become null
 * so they merge as "no value" (preserve existing) instead of overwriting with
 * ''. This makes the function safe to call DIRECTLY from sync code (Track B),
 * which bypasses the HTTP validation layer that would otherwise null empties.
 */
function sanitizeUpsertValue(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return v;
}

export interface UpsertContactResult {
  contact: Contact;
  created: boolean;
}

// Fields the sync always refreshes when the incoming value is NOT NULL.
const ALWAYS_UPDATE_FIELDS = [
  'owner_name', 'owner_phone', 'tenant_name', 'tenant_phone',
  'operator_name', 'operator_phone',
] as const;
// Manual fields — preserved when protectManualFields=true and already set in DB.
const PROTECTED_FIELDS = [
  'notes', 'address', 'tags', 'resident_type', 'operator_id',
  'apartment_size_sqm', 'management_fee',
  'owner_is_primary_contact', 'tenant_is_primary_contact', 'operator_is_primary_contact',
  'owner_email', 'tenant_email',
] as const;

async function _upsertContactByApartment(
  client: PoolClient,
  data: Partial<ContactWritableFields> & { apartment_number: string },
  opts: UpsertContactOpts,
): Promise<UpsertContactResult> {
  const protect = opts.protectManualFields ?? false;
  const rec = data as Record<string, unknown>;
  const apt = normalizeApartmentNumber(data.apartment_number ?? '');

  // INSERT side: apartment_number + last_synced_at=now() + (created_by) + provided fields.
  const cols: string[] = ['apartment_number', 'last_synced_at'];
  const vals: unknown[] = [apt];
  const insertExprs: string[] = ['$1', 'now()'];

  if (opts.createdBy !== undefined) {
    vals.push(opts.createdBy);
    cols.push('created_by');
    insertExprs.push(`$${vals.length}`);
  }

  // DO UPDATE side: only the provided writable fields, each per its merge rule.
  const setClauses: string[] = ['last_synced_at = now()'];
  const allowed = opts.allowedFields ? new Set(opts.allowedFields) : null;

  for (const c of WRITABLE_COLUMNS) {
    if (c === 'last_synced_at') continue; // managed above
    if (allowed && !allowed.has(c)) continue; // not owned by this sync — leave untouched
    if (!(c in rec) || rec[c] === undefined) continue;

    // Blank strings collapse to null → merge as "no value" (preserve existing).
    vals.push(sanitizeUpsertValue(rec[c]));
    const ph = `$${vals.length}`;
    cols.push(c);
    insertExprs.push(ph);

    const isProtected = (PROTECTED_FIELDS as readonly string[]).includes(c);
    const isAlways = (ALWAYS_UPDATE_FIELDS as readonly string[]).includes(c);

    if (protect && isProtected && !isAlways) {
      // Keep existing if already set; only fill when DB value is NULL.
      setClauses.push(`${c} = coalesce(contacts.${c}, excluded.${c})`);
    } else {
      // Update when the incoming value is NOT NULL, else keep existing.
      setClauses.push(`${c} = coalesce(excluded.${c}, contacts.${c})`);
    }
  }

  const r = await client.query<Contact & { inserted: boolean }>(
    `insert into public.contacts (${cols.join(', ')})
     values (${insertExprs.join(', ')})
     on conflict (apartment_number) do update set ${setClauses.join(', ')}
     returning ${CONTACT_COLUMNS}, (xmax = 0) as inserted`,
    vals,
  );
  const row = r.rows[0];
  const created = row.inserted;
  // Strip the helper flag from the returned Contact.
  const { inserted: _inserted, ...contact } = row;
  return { contact: contact as Contact, created };
}

async function _linkDebtorToContact(
  client: PoolClient,
  apartmentNumber: string,
  contactId: string,
): Promise<number> {
  const apt = normalizeApartmentNumber(apartmentNumber ?? '');
  const r = await client.query(
    `update public.debtors set contact_id = $1 where ${APT_KEY_SQL('apartment_number')} = $2`,
    [contactId, apt],
  );
  return r.rowCount ?? 0;
}

/**
 * UPSERT a contact keyed by normalized apartment_number. See UpsertContactOpts
 * for the field-merge rules. Returns the row + whether it was newly created.
 */
export async function upsertContactByApartment(
  data: Partial<ContactWritableFields> & { apartment_number: string },
  opts: UpsertContactOpts = {},
): Promise<UpsertContactResult> {
  return withTransaction((client) => _upsertContactByApartment(client, data, opts));
}

/**
 * Point a debtor at a contact by matching normalized apartment_number. Missing
 * debtor is not an error — returns the number of rows updated (0 or more).
 */
export async function linkDebtorToContact(
  apartmentNumber: string,
  contactId: string,
): Promise<number> {
  return withTransaction((client) => _linkDebtorToContact(client, apartmentNumber, contactId));
}

/**
 * Import hook: ensure every imported apartment has a contacts row, WITHOUT ever
 * touching an existing one — INSERT … ON CONFLICT (apartment_number) DO NOTHING
 * only. New rows are stamped source='bllink_sync' + needs_review=true so the
 * user can vet them in the registry. Then relinks ANY debtor with a NULL
 * contact_id to its apartment's contact (replace-mode recreates debtors
 * unlinked — this restores the links). One transaction, two bulk statements.
 * Returns how many contacts were created and how many debtors were relinked.
 */
export async function ensureContactsForApartments(
  rows: Array<{
    apartment_number: string;
    owner_name: string | null;
    phone_owner: string | null;
    phone_tenant: string | null;
  }>,
): Promise<{ created: number; relinked: number }> {
  return withTransaction(async (client) => {
    // Dedupe by normalized apartment (first occurrence wins) so the unnest
    // arrays never carry the same key twice — ON CONFLICT DO NOTHING cannot
    // dedupe duplicates within a single INSERT's own row set.
    const byApt = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const apt = normalizeApartmentNumber(r.apartment_number ?? '');
      if (!byApt.has(apt)) byApt.set(apt, r);
    }

    let created = 0;
    if (byApt.size > 0) {
      const apts: string[] = [];
      const ownerNames: Array<string | null> = [];
      const ownerPhones: Array<string | null> = [];
      const tenantPhones: Array<string | null> = [];
      for (const [apt, r] of byApt) {
        apts.push(apt);
        ownerNames.push(r.owner_name);
        ownerPhones.push(r.phone_owner);
        tenantPhones.push(r.phone_tenant);
      }
      const ins = await client.query(
        `insert into public.contacts
           (apartment_number, owner_name, owner_phone, tenant_phone, source, needs_review)
         select t.apt, t.owner_name, t.owner_phone, t.tenant_phone, 'bllink_sync', true
         from unnest($1::text[], $2::text[], $3::text[], $4::text[])
           as t(apt, owner_name, owner_phone, tenant_phone)
         on conflict (apartment_number) do nothing`,
        [apts, ownerNames, ownerPhones, tenantPhones],
      );
      created = ins.rowCount ?? 0;
    }

    const upd = await client.query(
      `update public.debtors d
          set contact_id = c.id
         from public.contacts c
        where d.contact_id is null
          and ${APT_KEY_SQL('d.apartment_number')} = ${APT_KEY_SQL('c.apartment_number')}`,
    );
    return { created, relinked: upd.rowCount ?? 0 };
  });
}

/**
 * Set contact phone fields for the apartment a debtor belongs to — the write
 * path for the tenant-panel phone edit. Direct SET of only the provided keys:
 * null CLEARS the field, so this must NOT go through the coalesce-based upsert
 * (which treats null as "preserve existing"). Creates + links the apartment's
 * contact row when the debtor has none. Returns 'no_contact' only when the
 * debtor id itself does not exist.
 */
export async function updateContactPhonesByDebtor(
  debtorId: string,
  phones: { owner_phone?: string | null; tenant_phone?: string | null },
): Promise<'updated' | 'no_contact'> {
  return withTransaction(async (client) => {
    const d = await client.query<{ apartment_number: string; contact_id: string | null }>(
      `select apartment_number, contact_id from public.debtors where id = $1`,
      [debtorId],
    );
    const debtor = d.rows[0];
    if (!debtor) return 'no_contact';

    let contactId = debtor.contact_id;
    if (!contactId) {
      // Debtor not linked yet — resolve-or-create the apartment's contact row, then link.
      const apt = normalizeApartmentNumber(debtor.apartment_number ?? '');
      await client.query(
        `insert into public.contacts (apartment_number, source)
         values ($1, 'manual')
         on conflict (apartment_number) do nothing`,
        [apt],
      );
      const c = await client.query<{ id: string }>(
        `select id from public.contacts where apartment_number = $1`,
        [apt],
      );
      contactId = c.rows[0].id;
      await client.query(
        `update public.debtors set contact_id = $1 where id = $2`,
        [contactId, debtorId],
      );
    }

    const set: string[] = [];
    const vals: unknown[] = [contactId];
    if (phones.owner_phone !== undefined) {
      vals.push(phones.owner_phone);
      set.push(`owner_phone = $${vals.length}`);
    }
    if (phones.tenant_phone !== undefined) {
      vals.push(phones.tenant_phone);
      set.push(`tenant_phone = $${vals.length}`);
    }
    if (set.length > 0) {
      await client.query(
        `update public.contacts set ${set.join(', ')} where id = $1`,
        vals,
      );
    }
    return 'updated';
  });
}

// ── Registry helpers (chips module consumes these) ───────────────────────

function residentCard(
  role: 'owner' | 'tenant' | 'operator',
  name: string | null,
  phone: string | null,
): ContactResidentCard {
  const n = name && name.trim() !== '' ? name.trim() : null;
  const p = phone && phone.trim() !== '' ? phone.trim() : null;
  return { role, name: n, phone: p, exists: n !== null && p !== null };
}

/**
 * The three inline resident slots of a contacts row, as cards for the issue
 * panel. exists = both name AND phone non-empty after trim. Null when the
 * contact does not exist.
 */
export async function getContactResidents(contactId: string): Promise<ContactResidents | null> {
  const row = await queryOne<{
    id: string;
    apartment_number: string;
    unit_type: string;
    resident_type: string;
    owner_name: string | null;
    owner_phone: string | null;
    tenant_name: string | null;
    tenant_phone: string | null;
    operator_name: string | null;
    operator_phone: string | null;
  }>(
    `select id, apartment_number, unit_type, resident_type,
            owner_name, owner_phone, tenant_name, tenant_phone,
            operator_name, operator_phone
       from public.contacts
      where id = $1`,
    [contactId],
  );
  if (!row) return null;
  return {
    contact_id: row.id,
    apartment_number: row.apartment_number,
    unit_type: row.unit_type,
    resident_type: row.resident_type,
    residents: [
      residentCard('owner', row.owner_name, row.owner_phone),
      residentCard('tenant', row.tenant_name, row.tenant_phone),
      residentCard('operator', row.operator_name, row.operator_phone),
    ],
  };
}

/** Set who currently lives in the unit. False when the contact is missing. */
export async function setContactResidentType(
  contactId: string,
  residentType: 'owner' | 'tenant' | 'operator',
): Promise<boolean> {
  const r = await query(
    `update public.contacts set resident_type = $2 where id = $1`,
    [contactId, residentType],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Lightweight registry lookup for the chip-issue contact picker — matches
 * apartment / owner / tenant. An exact apartment_number hit floats first, then
 * numeric-aware apartment order (length before lexicographic). Empty query → [].
 */
export async function searchContactsRegistry(
  q: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    apartment_number: string;
    unit_type: string;
    owner_name: string | null;
    tenant_name: string | null;
    resident_type: string;
    needs_review: boolean;
  }>
> {
  const term = q.trim();
  if (!term) return [];
  const r = await query<{
    id: string;
    apartment_number: string;
    unit_type: string;
    owner_name: string | null;
    tenant_name: string | null;
    resident_type: string;
    needs_review: boolean;
  }>(
    `select id, apartment_number, unit_type, owner_name, tenant_name, resident_type, needs_review
       from public.contacts
      where apartment_number ilike $1 or owner_name ilike $1 or tenant_name ilike $1
      order by (apartment_number = $2) desc, length(apartment_number), apartment_number
      limit $3`,
    [`%${term}%`, term, Math.max(1, Math.min(50, limit))],
  );
  return r.rows;
}

/**
 * Upsert a contact AND link the matching debtor to it in a single transaction —
 * the primary entry point for Track B sync (one call mutates both tables).
 */
export async function upsertContactAndLinkDebtor(
  data: Partial<ContactWritableFields> & { apartment_number: string },
  opts: UpsertContactOpts = {},
): Promise<UpsertContactResult & { debtorLinked: number }> {
  return withTransaction(async (client) => {
    const result = await _upsertContactByApartment(client, data, opts);
    const debtorLinked = await _linkDebtorToContact(client, data.apartment_number, result.contact.id);
    return { ...result, debtorLinked };
  });
}

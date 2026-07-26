import 'server-only';
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '@/lib/db';
import type {
  Contact,
  ContactListFilters,
  ContactWritableFields,
} from '@/lib/types/contacts';

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
  tenant_name, tenant_phone, tenant_email, resident_type, operator_id,
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
  'resident_type', 'operator_id',
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
  const cols: string[] = ['apartment_number', 'created_by'];
  const vals: unknown[] = [normalizeApartmentNumber(data.apartment_number ?? ''), createdBy];

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
const ALWAYS_UPDATE_FIELDS = ['owner_name', 'owner_phone', 'tenant_name', 'tenant_phone'] as const;
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

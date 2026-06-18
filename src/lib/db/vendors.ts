import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  Vendor,
  VendorListItem,
  VendorListFilters,
  VendorWritableFields,
} from '@/lib/types/vendors';

// DB layer for the Vendors module (lightweight service-provider directory).
// "Delete" is soft: is_active=false hides the vendor from the list; the row is
// kept so history/category counts stay coherent. Mirrors the suppliers layer.

const VENDOR_COLUMNS = `
  id, name, category_id, contact_person, phone, email, address, notes,
  is_active, created_by, created_at, updated_at`;

/**
 * List active vendors (is_active=true) with their category name, filtered by
 * category and a free-text search over name / contact / phone.
 */
export async function listVendors(filters: VendorListFilters): Promise<VendorListItem[]> {
  const where: string[] = ['v.is_active = true'];
  const params: unknown[] = [];

  if (filters.search && filters.search.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(v.name ilike ${p} or v.contact_person ilike ${p} or v.phone ilike ${p})`);
  }
  if (filters.category && filters.category !== 'all') {
    params.push(filters.category);
    where.push(`v.category_id = $${params.length}`);
  }

  const r = await query<VendorListItem>(
    `select v.id, v.name, v.category_id, v.contact_person, v.phone, v.email,
            v.address, v.notes, v.is_active, v.created_by, v.created_at, v.updated_at,
            c.name as category_name
       from public.vendors v
       left join public.vendor_categories c on c.id = v.category_id
      where ${where.join(' and ')}
      order by v.name asc`,
    params,
  );
  return r.rows;
}

export async function getVendorById(id: string): Promise<Vendor | null> {
  return queryOne<Vendor>(
    `select ${VENDOR_COLUMNS} from public.vendors where id = $1 and is_active = true`,
    [id],
  );
}

export async function createVendor(
  fields: VendorWritableFields,
  createdBy: string,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.vendors
       (name, category_id, contact_person, phone, email, address, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id`,
    [
      fields.name, fields.category_id, fields.contact_person, fields.phone,
      fields.email, fields.address, fields.notes, createdBy,
    ],
  );
  if (!row) throw new Error('failed_to_create_vendor');
  return row.id;
}

/** Whole-object update (the panel saves the full vendor in one PATCH). */
export async function updateVendor(id: string, fields: VendorWritableFields): Promise<boolean> {
  const r = await query(
    `update public.vendors set
       name=$2, category_id=$3, contact_person=$4, phone=$5, email=$6, address=$7, notes=$8
     where id=$1 and is_active = true`,
    [
      id, fields.name, fields.category_id, fields.contact_person, fields.phone,
      fields.email, fields.address, fields.notes,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Soft delete — flips is_active to false (kept for history + category counts). */
export async function softDeleteVendor(id: string): Promise<boolean> {
  const r = await query(
    `update public.vendors set is_active = false where id = $1 and is_active = true`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

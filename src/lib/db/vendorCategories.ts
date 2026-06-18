import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { VendorCategory, VendorCategoryWithCount } from '@/lib/types/vendors';

// Category queries for the Vendors module. Mirrors supplierCategories.ts.

const CATEGORY_COLUMNS = `id, name, is_active, created_at, updated_at`;

/** Active categories only — used by the filter and the vendor-form Select. */
export async function listActiveVendorCategories(): Promise<VendorCategory[]> {
  const r = await query<VendorCategory>(
    `select ${CATEGORY_COLUMNS}
       from public.vendor_categories
      where is_active = true
      order by name asc`,
  );
  return r.rows;
}

/** All categories with their live (active) vendor count — the management sheet. */
export async function listVendorCategoriesWithCounts(): Promise<VendorCategoryWithCount[]> {
  const r = await query<VendorCategoryWithCount>(
    `select c.id, c.name, c.is_active, c.created_at, c.updated_at,
            coalesce(count(v.id) filter (where v.is_active = true), 0)::int as linked_count
       from public.vendor_categories c
       left join public.vendors v on v.category_id = c.id
      group by c.id
      order by c.is_active desc, c.name asc`,
  );
  return r.rows;
}

export async function getVendorCategoryById(id: string): Promise<VendorCategory | null> {
  return queryOne<VendorCategory>(
    `select ${CATEGORY_COLUMNS} from public.vendor_categories where id = $1`,
    [id],
  );
}

/** Case-insensitive clash check (the DB unique constraint is case-sensitive). */
export async function findVendorCategoryByLowerName(
  lowerName: string,
  excludeId: string | null,
): Promise<{ id: string } | null> {
  if (excludeId) {
    return queryOne<{ id: string }>(
      `select id from public.vendor_categories
        where lower(name) = lower($1) and id <> $2
        limit 1`,
      [lowerName, excludeId],
    );
  }
  return queryOne<{ id: string }>(
    `select id from public.vendor_categories where lower(name) = lower($1) limit 1`,
    [lowerName],
  );
}

export async function createVendorCategory(name: string): Promise<VendorCategory> {
  const row = await queryOne<VendorCategory>(
    `insert into public.vendor_categories (name)
     values ($1)
     returning ${CATEGORY_COLUMNS}`,
    [name],
  );
  return row as VendorCategory;
}

export async function updateVendorCategory(
  id: string,
  patch: { name?: string; is_active?: boolean },
): Promise<VendorCategory | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    args.push(patch.name);
    sets.push(`name = $${args.length}`);
  }
  if (patch.is_active !== undefined) {
    args.push(patch.is_active);
    sets.push(`is_active = $${args.length}`);
  }
  if (sets.length === 0) return getVendorCategoryById(id);
  args.push(id);
  return queryOne<VendorCategory>(
    `update public.vendor_categories
        set ${sets.join(', ')}
      where id = $${args.length}
      returning ${CATEGORY_COLUMNS}`,
    args,
  );
}

/** Live (active) vendors currently assigned to a category — the delete guard. */
export async function countActiveVendorsInCategory(categoryId: string): Promise<number> {
  const r = await queryOne<{ c: number }>(
    `select count(*)::int as c
       from public.vendors
      where category_id = $1 and is_active = true`,
    [categoryId],
  );
  return r?.c ?? 0;
}

export async function deleteVendorCategory(id: string): Promise<void> {
  await query(`delete from public.vendor_categories where id = $1`, [id]);
}

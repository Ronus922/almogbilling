import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { SupplierCategory, SupplierCategoryWithCount } from '@/lib/types/suppliers';

const CATEGORY_COLUMNS = `id, name, is_active, created_at, updated_at`;

/** Active categories only — used by the filter and the supplier-form Select. */
export async function listActiveSupplierCategories(): Promise<SupplierCategory[]> {
  const r = await query<SupplierCategory>(
    `select ${CATEGORY_COLUMNS}
       from public.supplier_categories
      where is_active = true
      order by name asc`,
  );
  return r.rows;
}

/** All categories with their live-supplier count — used by the management sheet. */
export async function listSupplierCategoriesWithCounts(): Promise<SupplierCategoryWithCount[]> {
  const r = await query<SupplierCategoryWithCount>(
    `select c.id, c.name, c.is_active, c.created_at, c.updated_at,
            coalesce(count(s.id) filter (where s.deleted_at is null), 0)::int as linked_count
       from public.supplier_categories c
       left join public.suppliers s on s.category_id = c.id
      group by c.id
      order by c.is_active desc, c.name asc`,
  );
  return r.rows;
}

export async function getSupplierCategoryById(id: string): Promise<SupplierCategory | null> {
  return queryOne<SupplierCategory>(
    `select ${CATEGORY_COLUMNS} from public.supplier_categories where id = $1`,
    [id],
  );
}

/** Case-insensitive clash check (the DB unique constraint is case-sensitive). */
export async function findSupplierCategoryByLowerName(
  lowerName: string,
  excludeId: string | null,
): Promise<{ id: string } | null> {
  if (excludeId) {
    return queryOne<{ id: string }>(
      `select id from public.supplier_categories
        where lower(name) = lower($1) and id <> $2
        limit 1`,
      [lowerName, excludeId],
    );
  }
  return queryOne<{ id: string }>(
    `select id from public.supplier_categories where lower(name) = lower($1) limit 1`,
    [lowerName],
  );
}

export async function createSupplierCategory(name: string): Promise<SupplierCategory> {
  const row = await queryOne<SupplierCategory>(
    `insert into public.supplier_categories (name)
     values ($1)
     returning ${CATEGORY_COLUMNS}`,
    [name],
  );
  return row as SupplierCategory;
}

export async function updateSupplierCategory(
  id: string,
  patch: { name?: string; is_active?: boolean },
): Promise<SupplierCategory | null> {
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
  if (sets.length === 0) return getSupplierCategoryById(id);
  args.push(id);
  return queryOne<SupplierCategory>(
    `update public.supplier_categories
        set ${sets.join(', ')}
      where id = $${args.length}
      returning ${CATEGORY_COLUMNS}`,
    args,
  );
}

/** Live (non-deleted) suppliers currently assigned to a category — delete guard. */
export async function countLinkedSuppliersInCategory(categoryId: string): Promise<number> {
  const r = await queryOne<{ c: number }>(
    `select count(*)::int as c
       from public.suppliers
      where category_id = $1 and deleted_at is null`,
    [categoryId],
  );
  return r?.c ?? 0;
}

export async function deleteSupplierCategory(id: string): Promise<void> {
  await query(`delete from public.supplier_categories where id = $1`, [id]);
}

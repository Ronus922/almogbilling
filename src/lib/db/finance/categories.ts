import 'server-only';
import { query, queryOne, withTransaction } from '@/lib/db';
import type { FinCategory, FinCategoryInput } from '@/lib/types/finance';

export type { FinCategory, FinCategoryInput };

// Categories ("סעיפים") of the finance module. Dynamic — they start empty (no
// seed). A category that has entries (even soft-deleted ones) is never deleted,
// only deactivated: the history must keep pointing at a name.

/** Thrown on a name clash (unique (kind, name)). The route maps it to 409. */
export class FinanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceConflictError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

const COLS = `
  c.id, c.kind, c.name, c.sort_order, c.is_active, c.is_hot_water, c.section, c.created_at,
  (select count(*)::int from public.fin_entries e where e.category_id = c.id) as entries_count`;

export async function listCategories(opts: { includeInactive?: boolean } = {}): Promise<FinCategory[]> {
  const r = opts.includeInactive
    ? await query<FinCategory>(
        `select ${COLS} from public.fin_categories c
          order by c.kind, c.sort_order, c.name`,
      )
    : await query<FinCategory>(
        `select ${COLS} from public.fin_categories c
          where c.is_active
          order by c.kind, c.sort_order, c.name`,
      );
  return r.rows;
}

export async function getCategory(id: string): Promise<FinCategory | null> {
  return queryOne<FinCategory>(`select ${COLS} from public.fin_categories c where c.id = $1`, [id]);
}

/** New categories go to the end of their kind's list. */
export async function createCategory(input: FinCategoryInput, createdBy: string): Promise<FinCategory> {
  try {
    const row = await queryOne<{ id: string }>(
      `insert into public.fin_categories (kind, name, section, is_hot_water, is_active, sort_order, created_by)
       values ($1, $2, $3, $4, $5,
               coalesce((select max(sort_order) + 1 from public.fin_categories where kind = $1), 0),
               $6)
       returning id`,
      [input.kind, input.name, input.section, input.is_hot_water, input.is_active, createdBy],
    );
    return (await getCategory(row!.id))!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new FinanceConflictError('סעיף בשם זה כבר קיים');
    throw err;
  }
}

export async function updateCategory(
  id: string,
  patch: Partial<Omit<FinCategoryInput, 'kind'>>,
): Promise<FinCategory | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.section !== undefined) add('section', patch.section);
  if (patch.is_hot_water !== undefined) add('is_hot_water', patch.is_hot_water);
  if (patch.is_active !== undefined) add('is_active', patch.is_active);
  if (sets.length === 0) return getCategory(id);
  params.push(id);
  try {
    const r = await query<{ id: string }>(
      `update public.fin_categories set ${sets.join(', ')} where id = $${params.length} returning id`,
      params,
    );
    if (r.rowCount === 0) return null;
  } catch (err) {
    if (isUniqueViolation(err)) throw new FinanceConflictError('סעיף בשם זה כבר קיים');
    throw err;
  }
  return getCategory(id);
}

/** Persist a new order: the position in `ids` becomes sort_order. Ids not in the
 *  list keep their value — the caller sends the full list of one kind. */
export async function reorderCategories(ids: string[]): Promise<void> {
  await withTransaction(async (client) => {
    for (let i = 0; i < ids.length; i++) {
      await client.query(`update public.fin_categories set sort_order = $1 where id = $2`, [i, ids[i]]);
    }
  });
}

export async function deleteCategory(id: string): Promise<'deleted' | 'has_entries' | 'not_found'> {
  const cat = await getCategory(id);
  if (!cat) return 'not_found';
  if (cat.entries_count > 0) return 'has_entries';
  const r = await query(`delete from public.fin_categories where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0 ? 'deleted' : 'not_found';
}

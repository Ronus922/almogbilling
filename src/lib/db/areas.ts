import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { Area, AreaWritableFields } from '@/lib/types/areas';

const AREA_COLUMNS = `
  id, name, area_type, description, color, created_by, created_at, updated_at`;

/** List areas (optionally filtered by name/description), ordered by name. */
export async function listAreas(search?: string): Promise<Area[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    where.push(`(name ilike ${p} or description ilike ${p})`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<Area>(
    `select ${AREA_COLUMNS} from public.areas ${whereSql} order by name asc`,
    params,
  );
  return r.rows;
}

export async function getAreaById(id: string): Promise<Area | null> {
  return queryOne<Area>(
    `select ${AREA_COLUMNS} from public.areas where id = $1`,
    [id],
  );
}

export async function createArea(
  fields: AreaWritableFields,
  createdBy: string,
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.areas (name, area_type, description, color, created_by)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [fields.name, fields.area_type, fields.description, fields.color, createdBy],
  );
  if (!row) throw new Error('failed_to_create_area');
  return row.id;
}

/** Whole-object update (the panel saves the full area in one PATCH). */
export async function updateArea(id: string, fields: AreaWritableFields): Promise<boolean> {
  const r = await query(
    `update public.areas
       set name = $2, area_type = $3, description = $4, color = $5
     where id = $1`,
    [id, fields.name, fields.area_type, fields.description, fields.color],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteArea(id: string): Promise<boolean> {
  const r = await query(`delete from public.areas where id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

import 'server-only';
import { query } from '@/lib/db';
import type { RoomTarget, AreaTarget } from '@/lib/types/targets';

/**
 * Apartment options (target_type='room') — non-archived debtors, ordered by
 * apartment number numerically (so 2 < 10), name as tiebreaker.
 */
export async function listRoomTargets(): Promise<RoomTarget[]> {
  const r = await query<RoomTarget>(
    `select d.id, d.apartment_number,
            case when rc.id is null then d.owner_name else rc.owner_name end as owner_name
       from public.debtors d
       -- resident identity from contacts (registry); debtors columns are frozen legacy fallback (no linked contact only)
       left join public.contacts rc on rc.id = d.contact_id
      where d.is_archived = false
      order by
        nullif(regexp_replace(d.apartment_number, '\\D', '', 'g'), '')::int asc nulls last,
        d.apartment_number asc`,
  );
  return r.rows;
}

/** Area options (target_type='area'), ordered by name. */
export async function listAreaTargets(): Promise<AreaTarget[]> {
  const r = await query<AreaTarget>(
    `select id, name, area_type from public.areas order by name asc`,
  );
  return r.rows;
}

/**
 * SQL scalar subquery that resolves a task/issue's polymorphic target to a
 * display label — the apartment number for a 'room' (debtors), the area name for
 * an 'area' (areas) — inlined into a tasks/issues list/detail SELECT. `alias` is
 * a controlled identifier (never user input), so direct interpolation is safe.
 * Reads the SAME tables `listRoomTargets`/`listAreaTargets` (and TargetField)
 * use, so the table label matches the picker. NULL when there is no target.
 */
export function targetLabelSql(alias: string): string {
  return `case ${alias}.target_type
    when 'room' then (select d.apartment_number from public.debtors d where d.id = ${alias}.target_id)
    when 'area' then (select a.name from public.areas a where a.id = ${alias}.target_id)
  end as target_label`;
}

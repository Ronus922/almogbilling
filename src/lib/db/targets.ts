import 'server-only';
import { query } from '@/lib/db';
import type { RoomTarget, AreaTarget } from '@/lib/types/targets';

/**
 * Apartment options (target_type='room') — non-archived debtors, ordered by
 * apartment number numerically (so 2 < 10), name as tiebreaker.
 */
export async function listRoomTargets(): Promise<RoomTarget[]> {
  const r = await query<RoomTarget>(
    `select id, apartment_number, owner_name
       from public.debtors
      where is_archived = false
      order by
        nullif(regexp_replace(apartment_number, '\\D', '', 'g'), '')::int asc nulls last,
        apartment_number asc`,
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

import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { FinMonthStatus } from '@/lib/types/finance';

export type { FinMonthStatus };

// Month publishing (finance_month_status). A month with no row is unpublished.
// Toggling either way stamps published_at / published_by — the row records the
// last change, not only the first publish.

const COLS = `year, month, published, published_at, published_by`;

export async function getMonthStatus(year: number, month: number): Promise<FinMonthStatus> {
  const row = await queryOne<FinMonthStatus>(
    `select ${COLS} from public.finance_month_status where year = $1 and month = $2`,
    [year, month],
  );
  return row ?? { year, month, published: false, published_at: null, published_by: null };
}

/** Published (year, month) pairs, newest first. */
export async function listPublishedMonths(): Promise<Array<{ year: number; month: number }>> {
  const r = await query<{ year: number; month: number }>(
    `select year, month from public.finance_month_status where published order by year desc, month desc`,
  );
  return r.rows;
}

export async function setMonthPublished(
  year: number,
  month: number,
  published: boolean,
  actorId: string,
): Promise<FinMonthStatus> {
  const row = await queryOne<FinMonthStatus>(
    `insert into public.finance_month_status (year, month, published, published_at, published_by)
     values ($1, $2, $3, now(), $4)
     on conflict (year, month) do update
       set published = excluded.published, published_at = now(), published_by = excluded.published_by
     returning ${COLS}`,
    [year, month, published, actorId],
  );
  return row!;
}

import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { FinMonthStatus } from '@/lib/types/finance';

export type { FinMonthStatus };

// Month publishing (finance_month_status). A month with no row is unpublished.
// Toggling either way stamps published_at / published_by — the row records the
// last change, not only the first publish.

const COLS = `year, month, published, published_at, published_by,
  bank_balance::float8 as bank_balance, bank_balance_updated_at, bank_balance_updated_by`;

export async function getMonthStatus(year: number, month: number): Promise<FinMonthStatus> {
  const row = await queryOne<FinMonthStatus>(
    `select ${COLS} from public.finance_month_status where year = $1 and month = $2`,
    [year, month],
  );
  return row ?? {
    year, month, published: false, published_at: null, published_by: null,
    bank_balance: null, bank_balance_updated_at: null, bank_balance_updated_by: null,
  };
}

/** Published months that carry a bank balance, newest first — the portal's
 *  source (it is the caller's job to check the residents switch). */
export async function listPublishedMonthBalances(): Promise<Array<{ year: number; month: number; bank_balance: number }>> {
  const r = await query<{ year: number; month: number; bank_balance: number }>(
    `select year, month, bank_balance::float8 as bank_balance
       from public.finance_month_status
      where published and bank_balance is not null
      order by year desc, month desc`,
  );
  return r.rows;
}

/** Sets (or clears, with null) the month-end bank balance of one month. The
 *  row is created unpublished when it does not exist yet, so a balance can be
 *  typed before the month is shown to residents. */
export async function setMonthBankBalance(
  year: number,
  month: number,
  value: number | null,
  actorId: string,
): Promise<FinMonthStatus> {
  const row = await queryOne<FinMonthStatus>(
    `insert into public.finance_month_status (year, month, published, bank_balance, bank_balance_updated_at, bank_balance_updated_by)
     values ($1, $2, false, $3, now(), $4)
     on conflict (year, month) do update
       set bank_balance = excluded.bank_balance,
           bank_balance_updated_at = now(),
           bank_balance_updated_by = excluded.bank_balance_updated_by
     returning ${COLS}`,
    [year, month, value, actorId],
  );
  return row!;
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

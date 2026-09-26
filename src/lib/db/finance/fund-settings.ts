import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { RenovationFundSettings } from '@/lib/types/finance';

export type { RenovationFundSettings };

// The single row of renovation_fund_settings (id = 1): the collection target
// the cumulative fund KPI is measured against.

export async function getRenovationFundSettings(): Promise<RenovationFundSettings> {
  const row = await queryOne<RenovationFundSettings>(
    `select target_amount::float8 as target_amount, updated_at from public.renovation_fund_settings where id = 1`,
  );
  return row ?? { target_amount: 0, updated_at: new Date(0).toISOString() };
}

export async function updateRenovationFundSettings(
  input: { target_amount: number },
  updatedBy: string,
): Promise<RenovationFundSettings> {
  await query(
    `insert into public.renovation_fund_settings (id, target_amount, updated_by, updated_at)
     values (1, $1, $2, now())
     on conflict (id) do update
       set target_amount = excluded.target_amount, updated_by = excluded.updated_by, updated_at = now()`,
    [input.target_amount, updatedBy],
  );
  return getRenovationFundSettings();
}

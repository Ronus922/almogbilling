import 'server-only';
import { query } from '@/lib/db';
import type { PoolClient } from 'pg';
import type { CompletedAction } from '@/types/tenant';

export interface AppendCompletedActionArgs {
  debtor_id: string;
  apartment_number: string;
  description: string;
  due_date: string | null;
  completed_by: string | null;
  completed_by_name: string;
}

/** Insert a completed-action row. Use within a transaction (pass client). */
export async function insertCompletedAction(
  client: PoolClient,
  args: AppendCompletedActionArgs,
): Promise<void> {
  await client.query(
    `insert into public.completed_actions
       (debtor_id, apartment_number, description, due_date, completed_by, completed_by_name)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      args.debtor_id,
      args.apartment_number,
      args.description,
      args.due_date,
      args.completed_by,
      args.completed_by_name,
    ],
  );
}

export async function listCompletedActionsByDebtor(
  debtorId: string,
): Promise<CompletedAction[]> {
  const r = await query<CompletedAction>(
    `select id, debtor_id, apartment_number, description, due_date,
            completed_at, completed_by, completed_by_name
       from public.completed_actions
       where debtor_id = $1
       order by completed_at desc`,
    [debtorId],
  );
  return r.rows;
}

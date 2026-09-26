import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { FinanceSettings } from '@/lib/types/finance';

export type { FinanceSettings };

// The single settings row of the finance module (fin_settings, id = 1).
// show_documents_to_residents is only PERSISTED here — nothing enforces it
// until the owners portal (a later slice) reads it.

export async function getFinanceSettings(): Promise<FinanceSettings> {
  const row = await queryOne<FinanceSettings>(
    `select show_documents_to_residents, updated_at from public.fin_settings where id = 1`,
  );
  return row ?? { show_documents_to_residents: false, updated_at: null };
}

export async function updateFinanceSettings(
  input: { show_documents_to_residents: boolean },
  updatedBy: string,
): Promise<FinanceSettings> {
  await query(
    `insert into public.fin_settings (id, show_documents_to_residents, updated_by, updated_at)
     values (1, $1, $2, now())
     on conflict (id) do update
       set show_documents_to_residents = excluded.show_documents_to_residents,
           updated_by = excluded.updated_by,
           updated_at = now()`,
    [input.show_documents_to_residents, updatedBy],
  );
  return getFinanceSettings();
}

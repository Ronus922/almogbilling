import 'server-only';
import { query } from '@/lib/db';

export type LegalStatusHistorySource = 'MANUAL' | 'IMPORT' | 'AUTO_DEFAULT' | 'SYSTEM_FIX';

export interface LegalStatusHistoryEntry {
  id: string;
  debtor_id: string;
  apartment_number: string;
  old_status_id: string | null;
  old_status_name: string | null;
  new_status_id: string | null;
  new_status_name: string | null;
  changed_at: string;
  changed_by: string | null;
  changed_by_name: string | null;
  source: LegalStatusHistorySource;
  notes: string | null;
}

export interface AppendChangeArgs {
  debtor_id: string;
  apartment_number: string;
  old_status_id: string | null;
  old_status_name: string | null;
  new_status_id: string | null;
  new_status_name: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  source?: LegalStatusHistorySource;
  notes?: string | null;
}

export async function appendLegalStatusChange(args: AppendChangeArgs): Promise<void> {
  await query(
    `insert into public.legal_status_history
       (debtor_id, apartment_number,
        old_status_id, old_status_name,
        new_status_id, new_status_name,
        changed_by, changed_by_name, source, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      args.debtor_id,
      args.apartment_number,
      args.old_status_id,
      args.old_status_name,
      args.new_status_id,
      args.new_status_name,
      args.changed_by,
      args.changed_by_name,
      args.source ?? 'MANUAL',
      args.notes ?? null,
    ],
  );
}

export async function listLegalStatusHistoryByDebtor(
  debtorId: string,
): Promise<LegalStatusHistoryEntry[]> {
  const r = await query<LegalStatusHistoryEntry>(
    `select id, debtor_id, apartment_number,
            old_status_id, old_status_name,
            new_status_id, new_status_name,
            changed_at, changed_by, changed_by_name, source, notes
       from public.legal_status_history
       where debtor_id = $1
       order by changed_at desc`,
    [debtorId],
  );
  return r.rows;
}

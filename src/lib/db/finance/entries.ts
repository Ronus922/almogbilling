import 'server-only';
import { query, queryOne } from '@/lib/db';
import type { FinKind } from '@/lib/constants/finance';
import type { DuplicateExpense, FinEntry } from '@/lib/types/finance';
import { listDocumentsForEntries, toDocumentView } from './documents';

export type { FinEntry, DuplicateExpense };

export interface FinEntryInput {
  kind: FinKind;
  category_id: string;
  period_month: string;
  amount: number;
  description: string;
  internal_note: string;
  supplier_id: string | null;
  supplier_name: string;
  invoice_number: string;
  payment_date: string | null;
}

// Entries ("שורות") of the finance module: one income or expense line, entered
// per month. Soft-deleted. An expense counts in full in the month of its
// payment_date; period_month is derived from it by the route (never here).

type EntryRow = Omit<FinEntry, 'documents'>;

const COLS = `
  e.id, e.kind, e.category_id, c.name as category_name, c.section as category_section,
  c.is_hot_water as category_is_hot_water, c.sort_order as category_sort_order,
  e.period_month::text as period_month, e.amount::float8 as amount, e.description, e.internal_note,
  e.supplier_id, e.supplier_name, e.invoice_number, e.payment_date::text as payment_date,
  e.source, e.created_at, e.updated_at`;

async function withDocuments(rows: EntryRow[]): Promise<FinEntry[]> {
  const docs = await listDocumentsForEntries(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, documents: (docs.get(r.id) ?? []).map(toDocumentView) }));
}

/** All live entries of one month ('YYYY-MM-01'), in display order. */
export async function listEntriesForMonth(periodMonth: string): Promise<FinEntry[]> {
  const r = await query<EntryRow>(
    `select ${COLS}
       from public.fin_entries e
       join public.fin_categories c on c.id = e.category_id
      where e.deleted_at is null and e.period_month = $1::date
      order by e.kind, c.section, c.sort_order, c.name, coalesce(e.payment_date, e.period_month), e.created_at`,
    [periodMonth],
  );
  return withDocuments(r.rows);
}

export async function getEntry(id: string): Promise<FinEntry | null> {
  const row = await queryOne<EntryRow>(
    `select ${COLS}
       from public.fin_entries e
       join public.fin_categories c on c.id = e.category_id
      where e.id = $1 and e.deleted_at is null`,
    [id],
  );
  if (!row) return null;
  return (await withDocuments([row]))[0];
}

export async function createEntry(input: FinEntryInput, actorId: string): Promise<FinEntry> {
  const row = await queryOne<{ id: string }>(
    `insert into public.fin_entries
       (kind, category_id, period_month, amount, description, internal_note,
        supplier_id, supplier_name, invoice_number, payment_date, source, created_by, updated_by)
     values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::date, 'manual', $11, $11)
     returning id`,
    [
      input.kind, input.category_id, input.period_month, input.amount, input.description, input.internal_note,
      input.supplier_id, input.supplier_name, input.invoice_number, input.payment_date, actorId,
    ],
  );
  return (await getEntry(row!.id))!;
}

/** `kind` is immutable — an expense never becomes an income. */
export async function updateEntry(id: string, input: Omit<FinEntryInput, 'kind'>, actorId: string): Promise<FinEntry | null> {
  const r = await query(
    `update public.fin_entries
        set category_id = $2, period_month = $3::date, amount = $4, description = $5, internal_note = $6,
            supplier_id = $7, supplier_name = $8, invoice_number = $9, payment_date = $10::date, updated_by = $11
      where id = $1 and deleted_at is null`,
    [
      id, input.category_id, input.period_month, input.amount, input.description, input.internal_note,
      input.supplier_id, input.supplier_name, input.invoice_number, input.payment_date, actorId,
    ],
  );
  if ((r.rowCount ?? 0) === 0) return null;
  return getEntry(id);
}

export async function softDeleteEntry(id: string, actorId: string): Promise<boolean> {
  const r = await query(
    `update public.fin_entries set deleted_at = now(), deleted_by = $2, updated_by = $2
      where id = $1 and deleted_at is null`,
    [id, actorId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** A live expense with the same invoice number from the same supplier (by id,
 *  or by name when the supplier is free text). A warning, never a block. */
export async function findDuplicateExpense(input: {
  supplierId: string | null; supplierName: string; invoiceNumber: string; excludeId: string | null;
}): Promise<DuplicateExpense | null> {
  const invoice = input.invoiceNumber.trim();
  const name = input.supplierName.trim();
  if (!invoice || (!input.supplierId && !name)) return null;
  return queryOne<DuplicateExpense>(
    `select id, payment_date::text as payment_date, amount::float8 as amount, supplier_name
       from public.fin_entries
      where kind = 'expense' and deleted_at is null
        and lower(invoice_number) = lower($1)
        and (($2::uuid is not null and supplier_id = $2::uuid)
             or ($3 <> '' and lower(supplier_name) = lower($3)))
        and ($4::uuid is null or id <> $4::uuid)
      order by created_at desc
      limit 1`,
    [invoice, input.supplierId, name, input.excludeId],
  );
}

/** display_name of a live supplier, or null when the id is unknown/deleted. */
export async function resolveSupplierName(supplierId: string): Promise<string | null> {
  const row = await queryOne<{ display_name: string }>(
    `select display_name from public.suppliers where id = $1 and deleted_at is null`,
    [supplierId],
  );
  return row?.display_name ?? null;
}

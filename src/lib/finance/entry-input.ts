import 'server-only';
import type { FinanceEntryBody } from '@/lib/validation/requests';
import { getCategory } from '@/lib/db/finance/categories';
import { resolveSupplierName, type FinEntryInput } from '@/lib/db/finance/entries';
import { monthKeyOf, periodMonthOf } from './period';

/**
 * Turns a validated request body into what fin_entries stores — shared by
 * POST and PATCH so the two can never disagree on the rules:
 *   • the category must exist and match the entry's kind; on CREATE it must
 *     also be active (an inactive one keeps its old lines but takes no new);
 *   • an expense's period_month is derived from payment_date, an income's
 *     from the month picked;
 *   • a supplier picked from the table sets supplier_name from its
 *     display_name; free text keeps supplier_id null.
 */
export type ResolvedEntry = { ok: true; input: FinEntryInput } | { ok: false; error: string };

export async function resolveEntryInput(body: FinanceEntryBody, mode: 'create' | 'update'): Promise<ResolvedEntry> {
  const category = await getCategory(body.category_id);
  if (!category) return { ok: false, error: 'הסעיף לא נמצא' };
  if (category.kind !== body.kind) return { ok: false, error: 'הסעיף אינו מתאים לסוג השורה' };
  if (mode === 'create' && !category.is_active) return { ok: false, error: 'הסעיף אינו פעיל' };

  if (body.kind === 'income') {
    return {
      ok: true,
      input: {
        kind: 'income',
        category_id: body.category_id,
        period_month: periodMonthOf(body.month),
        amount: body.amount,
        description: body.description,
        internal_note: body.internal_note,
        supplier_id: null,
        supplier_name: '',
        invoice_number: '',
        payment_date: null,
      },
    };
  }

  let supplierName = body.supplier_name;
  if (body.supplier_id) {
    const name = await resolveSupplierName(body.supplier_id);
    if (!name) return { ok: false, error: 'הספק לא נמצא' };
    supplierName = name;
  }
  return {
    ok: true,
    input: {
      kind: 'expense',
      category_id: body.category_id,
      period_month: periodMonthOf(monthKeyOf(body.payment_date)),
      amount: body.amount,
      description: body.description,
      internal_note: body.internal_note,
      supplier_id: body.supplier_id,
      supplier_name: supplierName,
      invoice_number: body.invoice_number,
      payment_date: body.payment_date,
    },
  };
}

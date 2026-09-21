import { describe, expect, it } from 'vitest';
import {
  financeCategoryBodySchema, financeCategoryPatchSchema, financeCategoryOrderSchema,
  financeEntryBodySchema, financeSettingsBodySchema,
} from '@/lib/validation/requests';

const CAT = '11111111-1111-4111-8111-111111111111';
const SUP = '22222222-2222-4222-8222-222222222222';

describe('finance request schemas', () => {
  it('category: defaults + trimmed name, kind required', () => {
    const r = financeCategoryBodySchema.safeParse({ kind: 'expense', name: '  חשמל ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ kind: 'expense', name: 'חשמל', section: 'operating', is_hot_water: false, is_active: true });
    expect(financeCategoryBodySchema.safeParse({ kind: 'expense', name: '   ' }).success).toBe(false);
    expect(financeCategoryBodySchema.safeParse({ kind: 'other', name: 'x' }).success).toBe(false);
    expect(financeCategoryBodySchema.safeParse({ kind: 'income', name: 'x', section: 'savings' }).success).toBe(false);
  });

  it('category patch refuses an empty body; order needs uuids', () => {
    expect(financeCategoryPatchSchema.safeParse({}).success).toBe(false);
    expect(financeCategoryPatchSchema.safeParse({ is_active: false }).success).toBe(true);
    expect(financeCategoryOrderSchema.safeParse({ ids: [CAT] }).success).toBe(true);
    expect(financeCategoryOrderSchema.safeParse({ ids: ['nope'] }).success).toBe(false);
    expect(financeCategoryOrderSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('expense: payment_date required, supplier optional, defaults filled', () => {
    const ok = financeEntryBodySchema.safeParse({ kind: 'expense', category_id: CAT, amount: 120.5, payment_date: '2026-09-15' });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.kind === 'expense') {
      expect(ok.data.supplier_id).toBeNull();
      expect(ok.data.supplier_name).toBe('');
      expect(ok.data.invoice_number).toBe('');
      expect(ok.data.document_ids).toEqual([]);
    }
    expect(financeEntryBodySchema.safeParse({ kind: 'expense', category_id: CAT, amount: 10 }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ kind: 'expense', category_id: CAT, amount: 10, payment_date: '15/09/2026' }).success).toBe(false);
    const withSupplier = financeEntryBodySchema.safeParse({ kind: 'expense', category_id: CAT, amount: 10, payment_date: '2026-09-15', supplier_id: SUP, supplier_name: ' חברת חשמל ' });
    expect(withSupplier.success).toBe(true);
    if (withSupplier.success && withSupplier.data.kind === 'expense') expect(withSupplier.data.supplier_name).toBe('חברת חשמל');
  });

  it('income: month required (YYYY-MM), no supplier fields', () => {
    expect(financeEntryBodySchema.safeParse({ kind: 'income', category_id: CAT, amount: 500, month: '2026-09' }).success).toBe(true);
    expect(financeEntryBodySchema.safeParse({ kind: 'income', category_id: CAT, amount: 500 }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ kind: 'income', category_id: CAT, amount: 500, month: '2026-09-01' }).success).toBe(false);
  });

  it('amount: positive, at most 2 decimals; document_ids capped at 5', () => {
    const base = { kind: 'income', category_id: CAT, month: '2026-09' };
    expect(financeEntryBodySchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: -5 }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: 1.234 }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: '12' }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: 12.34 }).success).toBe(true);
    const six = Array.from({ length: 6 }, (_, i) => `33333333-3333-4333-8333-33333333333${i}`);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: 1, document_ids: six }).success).toBe(false);
    expect(financeEntryBodySchema.safeParse({ ...base, amount: 1, document_ids: six.slice(0, 5) }).success).toBe(true);
  });

  it('settings: a boolean, nothing else', () => {
    expect(financeSettingsBodySchema.safeParse({ show_documents_to_residents: true }).success).toBe(true);
    expect(financeSettingsBodySchema.safeParse({ show_documents_to_residents: 'yes' }).success).toBe(false);
  });
});

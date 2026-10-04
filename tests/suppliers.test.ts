import { describe, it, expect } from 'vitest';
import {
  coerceAndValidateSupplier,
  validateSupplierCategoryForm,
  canDeleteSupplierCategory,
  supplierContactsChanged,
} from '@/lib/validation/suppliers';
import { supplierContactsSchema } from '@/lib/validation/requests';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('coerceAndValidateSupplier — required + defaults', () => {
  it('requires display_name', () => {
    const r = coerceAndValidateSupplier({ display_name: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('display_name_required');
  });

  it('fills sensible defaults for a minimal supplier', () => {
    const r = coerceAndValidateSupplier({ display_name: '  אבי חשמל  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.display_name).toBe('אבי חשמל');
      expect(r.fields.supplier_type).toBe('general');
      expect(r.fields.status).toBe('active');
      expect(r.fields.payment_terms).toBe('immediate');
      expect(r.fields.category_id).toBeNull();
      expect(r.fields.phone).toBe('');
      expect(r.fields.mobile).toBe('');
    }
  });
});

describe('coerceAndValidateSupplier — phone via cleanPhoneField', () => {
  it('cleans a local mobile to canonical 0XXXXXXXXX', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', phone: '052-1234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('0521234567');
  });

  it('converts an international number to canonical local form', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', mobile: '+972521234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.mobile).toBe('0521234567');
  });

  it('accepts a landline', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', phone: '03-1234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('031234567');
  });

  it('rejects an unparseable phone', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', phone: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_phone');
  });

  it('rejects an unparseable mobile', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', mobile: '12' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_phone');
  });
});

describe('coerceAndValidateSupplier — email format', () => {
  it('accepts a valid address', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', email: 'supplier@example.com' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.email).toBe('supplier@example.com');
  });

  it('rejects a malformed address', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', email: 'not-an-email' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_email');
  });

  it('treats an empty email as blank', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', email: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.email).toBe('');
  });
});

describe('coerceAndValidateSupplier — category_id', () => {
  it('accepts a uuid', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', category_id: UUID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.category_id).toBe(UUID);
  });

  it('rejects a non-uuid category_id', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', category_id: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_category');
  });

  it('treats an empty category_id as null', () => {
    const r = coerceAndValidateSupplier({ display_name: 'ספק', category_id: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.category_id).toBeNull();
  });
});

describe('validateSupplierCategoryForm', () => {
  it('requires a name', () => {
    const r = validateSupplierCategoryForm({ name: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBeTruthy();
  });

  it('rejects an over-long name (>60)', () => {
    const r = validateSupplierCategoryForm({ name: 'א'.repeat(61) });
    expect(r.ok).toBe(false);
  });

  it('trims a valid name', () => {
    const r = validateSupplierCategoryForm({ name: '  אינסטלציה  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('אינסטלציה');
  });
});

describe('canDeleteSupplierCategory — delete guard', () => {
  it('allows deletion when no live suppliers are linked', () => {
    expect(canDeleteSupplierCategory(0)).toBe(true);
  });

  it('blocks deletion when live suppliers are linked', () => {
    expect(canDeleteSupplierCategory(1)).toBe(false);
    expect(canDeleteSupplierCategory(42)).toBe(false);
  });
});

// Additional contacts ("הוסף איש קשר נוסף") — the body list of POST/PATCH.
describe('supplierContactsSchema — additional contacts', () => {
  const row = { name: 'דנה', phone: '052-1234567', email: 'dana@example.com' };

  it('keeps name / email and cleans the phone like the supplier fields', () => {
    const r = supplierContactsSchema.safeParse([row]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual([{ name: 'דנה', phone: '0521234567', email: 'dana@example.com' }]);
    }
  });

  it('has exactly three fields — an unknown key (e.g. an old "role") is dropped', () => {
    const r = supplierContactsSchema.safeParse([{ ...row, role: 'הנהלת חשבונות' }, { role: 'מנהל' }]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual([{ name: 'דנה', phone: '0521234567', email: 'dana@example.com' }]);
    }
  });

  it('trims, defaults missing fields to empty, drops a fully blank row', () => {
    const r = supplierContactsSchema.safeParse([
      { name: '  יוסי  ' },
      { name: ' ', phone: '', email: '' },
      {},
    ]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual([{ name: 'יוסי', phone: '', email: '' }]);
  });

  it('accepts an empty list (removing every additional contact)', () => {
    const r = supplierContactsSchema.safeParse([]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual([]);
  });

  it('rejects an invalid phone with a Hebrew message', () => {
    const r = supplierContactsSchema.safeParse([{ ...row, phone: '12' }]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('מספר טלפון לא תקין באיש קשר נוסף');
  });

  it('rejects an invalid email with a Hebrew message', () => {
    const r = supplierContactsSchema.safeParse([{ ...row, email: 'not-an-email' }]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('כתובת אימייל לא תקינה באיש קשר נוסף');
  });

  it('rejects a non-list and more than 50 rows', () => {
    expect(supplierContactsSchema.safeParse('דנה').success).toBe(false);
    expect(supplierContactsSchema.safeParse([1]).success).toBe(false);
    expect(supplierContactsSchema.safeParse(Array.from({ length: 51 }, () => row)).success).toBe(false);
    expect(supplierContactsSchema.safeParse(Array.from({ length: 50 }, () => row)).success).toBe(true);
  });
});

describe('supplierContactsChanged — activity log + rewrite only on a real change', () => {
  const a = { name: 'דנה', phone: '0521234567', email: 'dana@example.com' };
  const b = { name: 'יוסי', phone: '', email: '' };

  it('same list (ids ignored) → unchanged', () => {
    expect(supplierContactsChanged([{ ...a, id: 'x', sort_order: 0 } as typeof a], [a])).toBe(false);
    expect(supplierContactsChanged([], [])).toBe(false);
  });

  it('added, removed, edited or reordered → changed', () => {
    expect(supplierContactsChanged([a], [a, b])).toBe(true);
    expect(supplierContactsChanged([a, b], [a])).toBe(true);
    expect(supplierContactsChanged([a], [{ ...a, name: 'דנה כהן' }])).toBe(true);
    expect(supplierContactsChanged([a], [{ ...a, phone: '0529999999' }])).toBe(true);
    expect(supplierContactsChanged([a], [{ ...a, email: 'other@example.com' }])).toBe(true);
    expect(supplierContactsChanged([a, b], [b, a])).toBe(true);
  });
});

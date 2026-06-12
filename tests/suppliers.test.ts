import { describe, it, expect } from 'vitest';
import {
  coerceAndValidateSupplier,
  validateSupplierCategoryForm,
  canDeleteSupplierCategory,
} from '@/lib/validation/suppliers';

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

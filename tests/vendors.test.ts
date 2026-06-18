import { describe, it, expect } from 'vitest';
import {
  coerceAndValidateVendor,
  validateVendorCategoryForm,
  canDeleteVendorCategory,
} from '@/lib/validation/vendors';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('coerceAndValidateVendor — required + defaults', () => {
  it('requires name', () => {
    const r = coerceAndValidateVendor({ name: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('name_required');
  });

  it('trims name and blanks the optional fields for a minimal vendor', () => {
    const r = coerceAndValidateVendor({ name: '  אבי אינסטלציה  ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields.name).toBe('אבי אינסטלציה');
      expect(r.fields.category_id).toBeNull();
      expect(r.fields.contact_person).toBe('');
      expect(r.fields.phone).toBe('');
      expect(r.fields.email).toBe('');
      expect(r.fields.address).toBe('');
      expect(r.fields.notes).toBe('');
    }
  });
});

describe('coerceAndValidateVendor — phone via cleanPhoneField', () => {
  it('cleans a local mobile to canonical 0XXXXXXXXX', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', phone: '052-1234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('0521234567');
  });

  it('converts an international number to canonical local form', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', phone: '+972521234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('0521234567');
  });

  it('accepts a landline', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', phone: '03-1234567' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('031234567');
  });

  it('rejects an unparseable phone', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', phone: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_phone');
  });

  it('treats an empty phone as blank', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', phone: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.phone).toBe('');
  });
});

describe('coerceAndValidateVendor — email format', () => {
  it('accepts a valid address', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', email: 'vendor@example.com' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.email).toBe('vendor@example.com');
  });

  it('rejects a malformed address', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', email: 'not-an-email' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_email');
  });

  it('treats an empty email as blank', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', email: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.email).toBe('');
  });
});

describe('coerceAndValidateVendor — category_id', () => {
  it('accepts a uuid', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', category_id: UUID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.category_id).toBe(UUID);
  });

  it('rejects a non-uuid category_id', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', category_id: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_category');
  });

  it('treats an empty category_id as null', () => {
    const r = coerceAndValidateVendor({ name: 'ספק', category_id: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.category_id).toBeNull();
  });
});

describe('validateVendorCategoryForm', () => {
  it('requires a name', () => {
    const r = validateVendorCategoryForm({ name: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBeTruthy();
  });

  it('rejects an over-long name (>60)', () => {
    const r = validateVendorCategoryForm({ name: 'א'.repeat(61) });
    expect(r.ok).toBe(false);
  });

  it('trims a valid name', () => {
    const r = validateVendorCategoryForm({ name: '  אינסטלציה  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('אינסטלציה');
  });
});

describe('canDeleteVendorCategory — delete guard', () => {
  it('allows deletion when no active vendors are linked', () => {
    expect(canDeleteVendorCategory(0)).toBe(true);
  });

  it('blocks deletion when active vendors are linked', () => {
    expect(canDeleteVendorCategory(1)).toBe(false);
    expect(canDeleteVendorCategory(42)).toBe(false);
  });
});

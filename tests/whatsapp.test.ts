import { describe, it, expect } from 'vitest';
import { normalizePhone, WhatsAppError } from '@/lib/whatsapp';
import { interpolateTemplate, formatDebt } from '@/lib/whatsapp-template';

describe('normalizePhone — Israeli phone → Green API chatId', () => {
  it('local mobile with leading 0 → 972 + chatId', () => {
    expect(normalizePhone('0541234567')).toEqual({
      phone: '972541234567',
      chatId: '972541234567@c.us',
    });
  });

  it('strips formatting (dashes / spaces)', () => {
    expect(normalizePhone('054-123-4567').phone).toBe('972541234567');
    expect(normalizePhone(' 054 123 4567 ').phone).toBe('972541234567');
  });

  it('already-international forms are preserved', () => {
    expect(normalizePhone('+972541234567').phone).toBe('972541234567');
    expect(normalizePhone('972541234567').phone).toBe('972541234567');
    expect(normalizePhone('00972541234567').phone).toBe('972541234567');
  });

  it('bare 9-digit subscriber number gets the 972 prefix', () => {
    expect(normalizePhone('541234567').phone).toBe('972541234567');
  });

  it('landline (8 subscriber digits) is valid', () => {
    expect(normalizePhone('03-1234567').phone).toBe('97231234567');
  });

  it('takes the first token of a multi-number cell', () => {
    expect(normalizePhone('0541234567 / 0521234567').phone).toBe('972541234567');
  });

  it('throws on empty / null / junk', () => {
    expect(() => normalizePhone('')).toThrow(WhatsAppError);
    expect(() => normalizePhone(null)).toThrow(WhatsAppError);
    expect(() => normalizePhone('123')).toThrow(WhatsAppError);
    expect(() => normalizePhone('abc')).toThrow(WhatsAppError);
  });
});

describe('interpolateTemplate — placeholder substitution', () => {
  const debtor = {
    owner_name: 'ישראל ישראלי',
    tenant_name: 'דייר אחר',
    total_debt: 12500,
    apartment_number: '14',
    address: 'רחוב הרצל 1',
  };

  it('replaces every known placeholder', () => {
    const out = interpolateTemplate(
      'שלום {{name}}, חוב {{debt}} לדירה {{apartment}} בבניין {{building_name}}',
      debtor,
    );
    expect(out).toContain('ישראל ישראלי');
    expect(out).toContain('14');
    expect(out).toContain('רחוב הרצל 1');
    expect(out).toContain('₪');
    expect(out).toContain('12,500');
  });

  it('{{name}} falls back to tenant_name when owner is missing', () => {
    const out = interpolateTemplate('{{name}}', { ...debtor, owner_name: null });
    expect(out).toBe('דייר אחר');
  });

  it('{{building_name}} falls back to address', () => {
    const out = interpolateTemplate('{{building_name}}', { ...debtor, building_name: null });
    expect(out).toBe('רחוב הרצל 1');
  });

  it('leaves an unknown placeholder verbatim', () => {
    expect(interpolateTemplate('hi {{foo}}', debtor)).toBe('hi {{foo}}');
  });

  it('formatDebt rounds and adds ₪ + thousands separator', () => {
    expect(formatDebt(0)).toBe('₪ 0');
    expect(formatDebt(12500.4)).toContain('12,500');
    expect(formatDebt(null)).toBe('₪ 0');
  });
});

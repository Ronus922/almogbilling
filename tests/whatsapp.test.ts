import { describe, it, expect } from 'vitest';
import {
  normalizePhone, parsePhoneCandidates, cleanPhoneField, splitOwnerTenantPhones,
  stripPhoneMarkup, phoneDigitsKey, WhatsAppError,
} from '@/lib/whatsapp';
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

describe('parsePhoneCandidates — compound debtor phone fields', () => {
  it('single clean number → one candidate, no label', () => {
    expect(parsePhoneCandidates('0525460546')).toEqual([
      { phone: '972525460546', label: null },
    ]);
  });

  it('two numbers each with a role label', () => {
    expect(parsePhoneCandidates('0525460546 (בעלים) 0521112222 (שוכר/ת)')).toEqual([
      { phone: '972525460546', label: 'בעלים' },
      { phone: '972521112222', label: 'שוכר/ת' },
    ]);
  });

  it('real-world string: real number kept (with label), 0000000000 dropped', () => {
    expect(parsePhoneCandidates('0525460546 (בעלים) 0000000000 (שוכר/ת)')).toEqual([
      { phone: '972525460546', label: 'בעלים' },
    ]);
  });

  it('placeholder 0000000000 only → empty', () => {
    expect(parsePhoneCandidates('0000000000')).toEqual([]);
    expect(parsePhoneCandidates('0000000000 (שוכר/ת)')).toEqual([]);
  });

  it('empty / whitespace / null → empty', () => {
    expect(parsePhoneCandidates('')).toEqual([]);
    expect(parsePhoneCandidates('   ')).toEqual([]);
    expect(parsePhoneCandidates(null)).toEqual([]);
  });

  it('number with dashes is recombined', () => {
    expect(parsePhoneCandidates('054-123-4567')).toEqual([
      { phone: '972541234567', label: null },
    ]);
  });

  it('de-duplicates the same number appearing twice', () => {
    expect(parsePhoneCandidates('0525460546 (בעלים) 0525460546 (שוכר)')).toEqual([
      { phone: '972525460546', label: 'בעלים' },
    ]);
  });

  it('landline (9 digits) is accepted', () => {
    expect(parsePhoneCandidates('03-1234567')).toEqual([
      { phone: '97231234567', label: null },
    ]);
  });

  it('Markdown tel: link → single candidate (href dropped, no bogus label)', () => {
    expect(parsePhoneCandidates('[054-977-6417](tel:0549776417)')).toEqual([
      { phone: '972549776417', label: null },
    ]);
  });

  it('Markdown link + a second labeled number in the same string', () => {
    expect(
      parsePhoneCandidates('[054-977-6417](tel:0549776417) (בעלים) 0525460546 (שוכר/ת)'),
    ).toEqual([
      { phone: '972549776417', label: 'בעלים' },
      { phone: '972525460546', label: 'שוכר/ת' },
    ]);
  });

  it('bare tel: prefix is stripped', () => {
    expect(parsePhoneCandidates('tel:0549776417')).toEqual([
      { phone: '972549776417', label: null },
    ]);
  });

  it('Markdown link with non-tel href also reduces to its text', () => {
    expect(parsePhoneCandidates('[0525460546](https://wa.me/972525460546)')).toEqual([
      { phone: '972525460546', label: null },
    ]);
  });
});

describe('cleanPhoneField — single clean local number (DB canonical)', () => {
  it('plain local number → itself', () => {
    expect(cleanPhoneField('0549776417')).toBe('0549776417');
  });

  it('strips Markdown link wrapper', () => {
    expect(cleanPhoneField('[054-977-6417](tel:0549776417)')).toBe('0549776417');
  });

  it('strips bare tel: prefix', () => {
    expect(cleanPhoneField('tel:0549776417')).toBe('0549776417');
  });

  it('compound labelled field → first (owner) number', () => {
    expect(cleanPhoneField('0547767953 (בעלים) 0507652079 (שוכר/ת)')).toBe('0547767953');
  });

  it('international 972 form → local', () => {
    expect(cleanPhoneField('+972549776417')).toBe('0549776417');
    expect(cleanPhoneField('972549776417')).toBe('0549776417');
  });

  it('9-digit mobile missing the trunk 0 → adds it (CRM data)', () => {
    expect(cleanPhoneField('523344580')).toBe('0523344580');
    expect(cleanPhoneField('505270433')).toBe('0505270433');
  });

  it('placeholder / empty / invalid → null', () => {
    expect(cleanPhoneField('0000000000')).toBeNull();
    expect(cleanPhoneField('')).toBeNull();
    expect(cleanPhoneField(null)).toBeNull();
    expect(cleanPhoneField('123')).toBeNull();
  });
});

describe('splitOwnerTenantPhones — entry-point split by label', () => {
  it('owner + tenant labels → both, clean local', () => {
    expect(splitOwnerTenantPhones('0547767953 (בעלים) 0507652079 (שוכר/ת)')).toEqual({
      owner: '0547767953',
      tenant: '0507652079',
    });
  });

  it('owner label + placeholder tenant → tenant dropped', () => {
    expect(splitOwnerTenantPhones('0547767953 (בעלים) 0000000000 (שוכר/ת)')).toEqual({
      owner: '0547767953',
      tenant: null,
    });
  });

  it('single number without label → owner (its default field)', () => {
    expect(splitOwnerTenantPhones('0549776417')).toEqual({ owner: '0549776417', tenant: null });
  });

  it('two unlabelled numbers → owner then tenant', () => {
    expect(splitOwnerTenantPhones('0549776417 0501112222')).toEqual({
      owner: '0549776417',
      tenant: '0501112222',
    });
  });

  it('Markdown owner link + labelled tenant', () => {
    expect(
      splitOwnerTenantPhones('[054-977-6417](tel:0549776417) (בעלים) 0507652079 (שוכר/ת)'),
    ).toEqual({ owner: '0549776417', tenant: '0507652079' });
  });

  it('owner number missing trunk 0 + placeholder tenant (real CRM row)', () => {
    expect(splitOwnerTenantPhones('523344580 (בעלים) 000000000 (שוכר/ת)')).toEqual({
      owner: '0523344580',
      tenant: null,
    });
  });

  it('labelled tenant inside the owner field moves to tenant', () => {
    expect(splitOwnerTenantPhones('0505390004 (שוכר/ת)')).toEqual({
      owner: null,
      tenant: '0505390004',
    });
  });

  it('empty → both null', () => {
    expect(splitOwnerTenantPhones('')).toEqual({ owner: null, tenant: null });
    expect(splitOwnerTenantPhones('0000000000')).toEqual({ owner: null, tenant: null });
  });
});

describe('phoneDigitsKey — normalized last-9 matching key', () => {
  it('unifies local / international / chat-id-stem / formatted forms', () => {
    // Same mobile, four representations → one key.
    expect(phoneDigitsKey('0525460546')).toBe('525460546');
    expect(phoneDigitsKey('972525460546')).toBe('525460546');
    expect(phoneDigitsKey('972525460546@c.us'.split('@')[0])).toBe('525460546');
    expect(phoneDigitsKey('052-546-0546')).toBe('525460546');
    expect(phoneDigitsKey('+972 52 546 0546')).toBe('525460546');
  });

  it('local and intl forms of the same number share a key (the linking guarantee)', () => {
    expect(phoneDigitsKey('0541234567')).toBe(phoneDigitsKey('972541234567'));
    expect(phoneDigitsKey('0521112222')).toBe(phoneDigitsKey('972521112222'));
  });

  it('distinct numbers do NOT collide', () => {
    expect(phoneDigitsKey('0541234567')).not.toBe(phoneDigitsKey('0541234568'));
  });

  it('fewer than 9 digits → null', () => {
    expect(phoneDigitsKey('12345')).toBeNull();
    expect(phoneDigitsKey('')).toBeNull();
    expect(phoneDigitsKey(null)).toBeNull();
    expect(phoneDigitsKey(undefined)).toBeNull();
  });
});

describe('stripPhoneMarkup', () => {
  it('reduces a Markdown link to its text and drops tel:', () => {
    expect(stripPhoneMarkup('[054-977-6417](tel:0549776417)')).toBe('054-977-6417');
    expect(stripPhoneMarkup('tel:0549776417')).toBe('0549776417');
  });
  it('leaves a real (בעלים) label intact', () => {
    expect(stripPhoneMarkup('0549776417 (בעלים)')).toBe('0549776417 (בעלים)');
  });
});

describe('interpolateTemplate — placeholder substitution', () => {
  const debtor = {
    owner_name: 'ישראל ישראלי',
    tenant_name: 'דייר אחר',
    total_debt: 12500,
    management_fees: 8400,
    hot_water_debt: 1200,
  };

  it('replaces the full supported set: name / debt / monthly / special', () => {
    const out = interpolateTemplate(
      'שלום {{name}}, סה״כ {{debt}}, דמי ניהול {{monthly}}, מיוחד {{special}}',
      debtor,
    );
    expect(out).toContain('ישראל ישראלי');
    expect(out).toContain('₪');
    expect(out).toContain('12,500'); // debt
    expect(out).toContain('8,400');  // monthly = management_fees
    expect(out).toContain('1,200');  // special = hot_water_debt
  });

  // Regression (apt 1628): Bllink writes the special debt to hot_water_debt
  // while the legacy special_debt column is zeroed by every import. {{special}}
  // must read hot_water_debt — reading special_debt rendered "₪ 0" for a debtor
  // who owed 727.
  it('{{special}} reads hot_water_debt even when legacy special_debt is 0', () => {
    const out = interpolateTemplate('{{special}}', {
      owner_name: 'א', total_debt: 4959, management_fees: 4232,
      hot_water_debt: 727, special_debt: 0,
    });
    expect(out).toBe('₪ 727');
  });

  it('{{special}} falls back to legacy special_debt when hot_water_debt is absent', () => {
    expect(interpolateTemplate('{{special}}', { owner_name: 'א', special_debt: 300 })).toBe('₪ 300');
  });

  it('{{name}} falls back to tenant_name when owner is empty', () => {
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: null })).toBe('דייר אחר');
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: '   ' })).toBe('דייר אחר');
  });

  it('{{name}} defaults to "דייר יקר" when both names are empty', () => {
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: null, tenant_name: null })).toBe('דייר יקר');
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: ' / ', tenant_name: '' })).toBe('דייר יקר');
  });

  it('{{name}} strips separator chars (/ ,) and whitespace from the edges', () => {
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: 'ישראל ישראלי / ' })).toBe('ישראל ישראלי');
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: ', דנה כהן' })).toBe('דנה כהן');
    expect(interpolateTemplate('{{name}}', { ...debtor, owner_name: ' / משה /' })).toBe('משה');
  });

  it('null money fields render as ₪ 0', () => {
    const out = interpolateTemplate('{{debt}}|{{monthly}}|{{special}}', {
      owner_name: 'א', total_debt: null, management_fees: null, hot_water_debt: null,
    });
    expect(out).toBe('₪ 0|₪ 0|₪ 0');
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

import { describe, it, expect } from 'vitest';
import {
  normalizePhone, parsePhoneCandidates, cleanPhoneField, splitOwnerTenantPhones,
  stripPhoneMarkup, phoneDigitsKey, WhatsAppError,
} from '@/lib/whatsapp';
import {
  interpolateTemplate, formatDebt, resolveConsolidatedName, isDebtMessageTemplate,
  parseApartmentsBlock, interpolateBroadcastTemplate, templateUsesApartmentOutsideBlock,
} from '@/lib/whatsapp-template';

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

describe('resolveConsolidatedName — {{name}} for a recipient with several apartments', () => {
  it('all apartments agree on one (trimmed) name → uses it', () => {
    expect(resolveConsolidatedName(['אסף בן שמואל', 'אסף בן שמואל'])).toBe('אסף בן שמואל');
    expect(resolveConsolidatedName(['משה / ', ' משה'])).toBe('משה'); // separator-trim, same as resolveName
  });

  it('real conflict (apt 513/514 "יעקב בזק" vs extra apt 1011 "אלה בסנקו מתאריך") → empty, stays neutral', () => {
    expect(resolveConsolidatedName(['יעקב בזק', 'יעקב בזק', 'אלה בסנקו מתאריך', null])).toBe('');
  });

  it('a blank name on one apartment does not count as a conflict against a single real name', () => {
    expect(resolveConsolidatedName(['יעקב בזק', null, '', '   '])).toBe('יעקב בזק');
  });

  it('no name anywhere → "דייר יקר", same default as the single-apartment case', () => {
    expect(resolveConsolidatedName([null, '', '  '])).toBe('דייר יקר');
    expect(resolveConsolidatedName([])).toBe('דייר יקר');
  });
});

describe('isDebtMessageTemplate — routes free-form announcements vs debt broadcasts', () => {
  it('a money token, or the repeating block, makes it a debt message', () => {
    expect(isDebtMessageTemplate('חוב: {{debt}}')).toBe(true);
    expect(isDebtMessageTemplate('{{monthly}} / {{special}}')).toBe(true);
    expect(isDebtMessageTemplate('סה"כ {{total_debt}}')).toBe(true);
    expect(isDebtMessageTemplate('{{#apartments}}{{/apartments}}')).toBe(true);
  });

  it('{{name}} alone does NOT make it a debt message', () => {
    expect(isDebtMessageTemplate('{{name}} שלום,')).toBe(false);
  });

  // PR ב': {{apartment}} alone (no money token) is free-form — e.g. a
  // malfunction notice naming one apartment doesn't need a debt breakdown, and
  // must not be blocked/consolidated. It stays on the untouched single-value
  // path, {{apartment}} resolving exactly as interpolateTemplate always has.
  it('{{apartment}} alone does NOT make it a debt message (malfunction-notice case)', () => {
    expect(isDebtMessageTemplate('יש תקלה בדירה {{apartment}}, אנא פנו למשרד')).toBe(false);
    expect(isDebtMessageTemplate('{{name}} שלום, דירה {{apartment}}')).toBe(false);
  });

  it('{{apartment}} together with a money token IS a debt message', () => {
    expect(isDebtMessageTemplate('לדירה {{apartment}}: {{debt}}')).toBe(true);
  });

  // Regression: the 3 real historical broadcasts (verified against production
  // 21/09/2026) must keep classifying as free-form — they carry no debt data
  // and must render byte-for-byte identical before/after this feature exists.
  it('the 3 real historical campaign bodies classify as free-form', () => {
    const assembly = '{{name}} שלום,\n\nבנוסף להזמנה רשמית שנתלתה כדין, ברצוננו לעדכנכם גם כאן, כי אסיפת דיירים תתקיים ביום שני, 10.08.2026, בשעה 18:00, באולם שבלובי הבניין.';
    const ac = 'דיירים נכבדים,\n\nאתמול בערב אירעה תקלה במערכת המיזוג המרכזית של הבניין, שמקורה במגדלי הקירור. התקלה טופלה, והיום מערכת המיזוג צפויה לפעול כסדרה.';
    const coolingTowers = 'שבוע טוב,\nעקב בעיה רצינית במגדלי הקירור יש בעיה זמנית במערכת המיזוג וייתכן שניאלץ להשבית את המערכות לפחות עד מחר.';
    expect(isDebtMessageTemplate(assembly)).toBe(false);
    expect(isDebtMessageTemplate(ac)).toBe(false);
    expect(isDebtMessageTemplate(coolingTowers)).toBe(false);
  });
});

// PR ב': the campaign-creation hard block only applies to a DEBT-classified
// template (see isDebtMessageTemplate) that uses bare {{apartment}} where the
// consolidation engine can't resolve it to one value — never to a free-form
// template, which keeps {{apartment}}'s pre-existing single-value behavior.
describe('templateUsesApartmentOutsideBlock — the campaign-creation hard-block signal', () => {
  it('bare {{apartment}} with no block at all → true', () => {
    expect(templateUsesApartmentOutsideBlock('לדירה {{apartment}}: {{debt}}')).toBe(true);
  });

  it('{{apartment}} used ONLY inside the repeating block → false', () => {
    expect(templateUsesApartmentOutsideBlock('שלום {{name}},\n{{#apartments}}דירה {{apartment}}: {{debt}}\n{{/apartments}}')).toBe(false);
  });

  it('{{apartment}} in the prefix/suffix, outside the block → true even though a block exists', () => {
    expect(templateUsesApartmentOutsideBlock('דירה ראשית: {{apartment}}\n{{#apartments}}{{debt}}\n{{/apartments}}')).toBe(true);
    expect(templateUsesApartmentOutsideBlock('{{#apartments}}{{debt}}\n{{/apartments}}\nלשאלות בדירה {{apartment}} פנו למשרד')).toBe(true);
  });

  it('no {{apartment}} anywhere → false', () => {
    expect(templateUsesApartmentOutsideBlock('שלום {{name}}, חובך: {{debt}}')).toBe(false);
  });
});

describe('parseApartmentsBlock — {{#apartments}}...{{/apartments}} validation', () => {
  it('no block at all → ok, block: null', () => {
    const r = parseApartmentsBlock('שלום {{name}}, החוב שלך {{debt}}');
    expect(r.ok).toBe(true);
    expect(r.block).toBeNull();
  });

  it('a valid block splits into prefix / blockTemplate / suffix', () => {
    const r = parseApartmentsBlock('פתיחה{{#apartments}}גוף{{/apartments}}סיום');
    expect(r.ok).toBe(true);
    expect(r.block).toEqual({ prefix: 'פתיחה', blockTemplate: 'גוף', suffix: 'סיום' });
  });

  it('opened but not closed → Hebrew error, blocks save', () => {
    const r = parseApartmentsBlock('{{#apartments}}גוף');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('נפתח אך לא נסגר');
  });

  it('closed without an opening → Hebrew error', () => {
    const r = parseApartmentsBlock('גוף{{/apartments}}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ללא פתיחה תואמת');
  });

  it('more than one block (two opens, or two closes) → Hebrew error', () => {
    expect(parseApartmentsBlock('{{#apartments}}א{{/apartments}}{{#apartments}}ב{{/apartments}}').ok).toBe(false);
    expect(parseApartmentsBlock('{{#apartments}}{{/apartments}}{{/apartments}}').ok).toBe(false);
  });

  it('reversed order (close before open) → Hebrew error', () => {
    const r = parseApartmentsBlock('{{/apartments}}א{{#apartments}}');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('הפוך');
  });
});

describe('interpolateBroadcastTemplate — multi-apartment rendering', () => {
  const template = 'שלום {{name}},\n{{#apartments}}(מס\' דירה: {{apartment}}): {{monthly}} / {{special}} / {{debt}}\n{{/apartments}}\nסה"כ: {{total_debt}}';

  it('single apartment → identical to today (same numbers as interpolateTemplate)', () => {
    const r = interpolateBroadcastTemplate(template, {
      name: 'יהונתן אביגדור',
      apartments: [{ apartment_number: '1233', total_debt: 2408, management_fees: 2388, hot_water_debt: 20 }],
    });
    expect(r.text).toContain('שלום יהונתן אביגדור');
    expect(r.text).toContain("מס' דירה: 1233");
    expect(r.text).toContain('₪ 2,408'); // per-apartment {{debt}}
    expect(r.text).toContain('סה"כ: ₪ 2,408'); // {{total_debt}} sums to the same single value
    expect(r.truncated).toBe(false);
  });

  it('several apartments render in ascending apartment_number order, each with its own numbers', () => {
    const r = interpolateBroadcastTemplate(template, {
      name: 'אסף בן שמואל',
      apartments: [
        { apartment_number: '1041', total_debt: 25188, management_fees: 22890, hot_water_debt: 2298 },
        { apartment_number: '721', total_debt: 15105, management_fees: 14175, hot_water_debt: 930 },
      ],
    });
    const idx721 = r.text.indexOf('721');
    const idx1041 = r.text.indexOf('1041');
    expect(idx721).toBeGreaterThan(-1);
    expect(idx1041).toBeGreaterThan(idx721); // 721 before 1041 — ascending, not insertion order
    expect(r.text).toContain('סה"כ: ₪ 40,293'); // 15,105 + 25,188
  });

  it('no block in the template: {{debt}}/{{monthly}}/{{special}} sum across apartments (backward compat)', () => {
    const r = interpolateBroadcastTemplate('חוב כולל: {{debt}}, דמי ניהול: {{monthly}}', {
      name: 'X',
      apartments: [
        { apartment_number: '1', total_debt: 100, management_fees: 60 },
        { apartment_number: '2', total_debt: 200, management_fees: 40 },
      ],
    });
    expect(r.text).toBe('חוב כולל: ₪ 300, דמי ניהול: ₪ 100');
  });

  it('no block, multiple apartments: {{apartment}} is blank (defensive — real gate is campaign creation)', () => {
    const r = interpolateBroadcastTemplate('דירה: {{apartment}}', {
      name: 'X',
      apartments: [{ apartment_number: '1', total_debt: 1 }, { apartment_number: '2', total_debt: 2 }],
    });
    // trailing space left by the blank {{apartment}} is trimmed by normalizeGaps
    expect(r.text).toBe('דירה:');
  });

  it('conflicting name (empty) swallows a directly-following comma — no dangling "שלום ,"', () => {
    const r = interpolateBroadcastTemplate('שלום {{name}}, מה שלומך', {
      name: '', // resolveConsolidatedName already decided this is a conflict
      apartments: [{ apartment_number: '1', total_debt: 1 }],
    });
    expect(r.text).toBe('שלום מה שלומך');
    expect(r.text).not.toContain(',');
  });

  it('truncation: ≤3 cut apartments are listed by number; >3 use the count form', () => {
    const many = (n: number, base = 1000) => Array.from({ length: n }, (_, i) => ({
      apartment_number: String(base + i),
      total_debt: 1000, // padded body per apartment to force the 3000-char budget within a small N
    }));
    const heavyBlock = 'שלום {{name}},\n{{#apartments}}דירה מספר {{apartment}} — סכום לתשלום כולל דמי ניהול ומים חמים: {{debt}} בבקשה שלמו בהקדם האפשרי תודה רבה\n{{/apartments}}';
    const r = interpolateBroadcastTemplate(heavyBlock, { name: 'X', apartments: many(45) });
    expect(r.truncated).toBe(true);
    expect(r.shownApartments + r.cutApartmentNumbers.length).toBe(45);
    expect(r.cutApartmentNumbers.length).toBeGreaterThan(0);
    if (r.cutApartmentNumbers.length <= 3) {
      expect(r.text).toMatch(/ועוד דיר(ה|ות) \d+/);
    } else {
      expect(r.text).toContain(`ועוד ${r.cutApartmentNumbers.length} דירות נוספות`);
    }
    expect(r.text).toContain('סה"כ');
  });

  it('the real largest operator today (40 apartments, 0546557004) stays under the 4,096 body limit', () => {
    // Same shape as the real saved template "פירוט חוב מלא" (double-₪ included —
    // that bug is reported separately, not fixed here) on the real per-apartment
    // block length (~76 chars/apartment measured 21/09/2026).
    const realShapeBlock = "שלום {{name}},\nלהלן פירוט יתרת החוב שלך:\n{{#apartments}}(מס' דירה: {{apartment}}):\n• דמי ניהול: {{monthly}} ₪\n• מים חמים: {{special}} ₪\n• סה\"כ חוב: {{debt}} ₪\n\n{{/apartments}}\nנבקשך לסדר את התשלום בהקדם.\nתודה, ועד הבית.";
    const apartments = Array.from({ length: 40 }, (_, i) => ({
      apartment_number: String(500 + i),
      total_debt: 1000 + i * 37,
      management_fees: 0,
      hot_water_debt: 0,
    }));
    const r = interpolateBroadcastTemplate(realShapeBlock, { name: 'אלמוג ביץ', apartments });
    // Confirmed against the real 40-apartment operator on 21/09/2026: renders
    // to ~3,111 chars — comfortably under 4,096, but past the 3,000-char
    // truncation budget (39 shown, 1 summarized). The truncation firing here,
    // on real-scale data, on day one, is exactly why the cap is in this PR.
    expect(r.text.length).toBeLessThan(4096);
    expect(r.truncated).toBe(true);
    expect(r.shownApartments).toBeGreaterThanOrEqual(35);
    expect(r.shownApartments).toBeLessThan(40);
  });
});

import { describe, expect, it } from 'vitest';
import { splitOwnerTenantNames } from '@/lib/sync/reportNames';

// The Bllink report's name cell (see src/lib/sync/reportNames.ts). Fixtures are
// real strings from the 29/09/2026 scrape, with the owner names they must and
// must NOT produce — approving a tenant's name into the owner field is the
// failure this guards.
describe('the report name cell, split by role', () => {
  it('takes the owner part and nothing else', () => {
    expect(splitOwnerTenantNames('ס נ נדל״ן  (בעלים)')).toEqual({ owner: 'ס נ נדל״ן', tenant: null });
    expect(splitOwnerTenantNames('בלכנר חנה (בעלים) אור מזוז דירות נופש (שוכר/ת)'))
      .toEqual({ owner: 'בלכנר חנה', tenant: 'אור מזוז דירות נופש' });
    expect(splitOwnerTenantNames('רענן אסא (בעלים) ליים (שוכר/ת)'))
      .toEqual({ owner: 'רענן אסא', tenant: 'ליים' });
  });

  it('a tenant-only cell yields NO owner name', () => {
    expect(splitOwnerTenantNames('אור מזוז (שוכר/ת)').owner).toBeNull();
    expect(splitOwnerTenantNames("כרמל ביץ' אפרטמנטס- טלי אראל  (שוכר/ת)").owner).toBeNull();
    // Two labels, no name between them — a guess would be worse than nothing.
    expect(splitOwnerTenantNames('אלמוג ביץ דירות נופש בע"מ (שוכר) (בעלים)'))
      .toEqual({ owner: null, tenant: 'אלמוג ביץ דירות נופש בע"מ' });
  });

  it('an unlabelled cell is the owner — what the whole cell always meant', () => {
    expect(splitOwnerTenantNames('אסף בן שמואל')).toEqual({ owner: 'אסף בן שמואל', tenant: null });
    expect(splitOwnerTenantNames('  אמיר רימון /יורשי המנוח מנחם רימון  ').owner)
      .toBe('אמיר רימון /יורשי המנוח מנחם רימון');
  });

  it('a parenthesis that is not a role stays part of the name', () => {
    expect(splitOwnerTenantNames('חברה (2010) בע״מ (בעלים)').owner).toBe('חברה (2010) בע״מ');
    expect(splitOwnerTenantNames('חברה (2010) בע״מ').owner).toBe('חברה (2010) בע״מ');
  });

  it('empty input yields nothing', () => {
    for (const raw of [null, undefined, '', '   ', '(בעלים)']) {
      expect(splitOwnerTenantNames(raw).owner).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { hasMixedOwners, normalizeOwnerName } from '@/lib/portal/ownership';

// Containment (03/10/2026): a phone whose ACTIVE apartments belong to different
// people sees no financial data in the portal (lib/portal/ownership.ts). The
// rule itself, without a database.

const row = (apartment_number: string, owner_name: string | null) => ({ apartment_number, owner_name });

describe('normalizeOwnerName', () => {
  it('trims and collapses whitespace; empty is null', () => {
    expect(normalizeOwnerName('  דנה   לוי ')).toBe('דנה לוי');
    expect(normalizeOwnerName('דנה\tלוי')).toBe('דנה לוי');
    expect(normalizeOwnerName('   ')).toBeNull();
    expect(normalizeOwnerName(null)).toBeNull();
    expect(normalizeOwnerName(undefined)).toBeNull();
  });
});

describe('hasMixedOwners', () => {
  it('one apartment is never mixed — even with no name, even with several rows', () => {
    expect(hasMixedOwners([])).toBe(false);
    expect(hasMixedOwners([row('520', 'טלי אראל')])).toBe(false);
    expect(hasMixedOwners([row('520', null)])).toBe(false);
  });

  it('several apartments of the same person (names equal after whitespace) → not mixed', () => {
    expect(hasMixedOwners([row('1210', 'רונן משולם'), row('1237', 'רונן משולם')])).toBe(false);
    expect(hasMixedOwners([row('1210', 'רונן  משולם'), row('1237', ' רונן משולם ')])).toBe(false);
  });

  it('apartments of two different people → mixed (the case found on 03/10/2026)', () => {
    expect(hasMixedOwners([row('1210', 'רונן משולם'), row('1237', "אלי אברג'יל"), row('520', 'טלי אראל')])).toBe(true);
    expect(hasMixedOwners([row('1608', 'ליאורה מעיין'), row('520', 'יעקב מעיין')])).toBe(true);
  });

  it('a nameless row on a multi-apartment phone cannot show it is one person → mixed', () => {
    expect(hasMixedOwners([row('1323', null), row('1324', 'שפייזר אייל')])).toBe(true);
    expect(hasMixedOwners([row('1', null), row('2', null)])).toBe(true);
    expect(hasMixedOwners([row('1', '  '), row('2', 'דנה')])).toBe(true);
  });
});

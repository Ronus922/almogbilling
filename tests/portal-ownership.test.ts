import { describe, expect, it } from 'vitest';
import { normalizeOwnerName } from '@/lib/portal/ownership';
import {
  compareApartmentNumbers, decidePortalIdentity, rolesLabel, type IdentityLink, type PortalRole,
} from '@/lib/portal/identity';

// The portal's ONE identity decision (03/10/2026, lib/portal/identity.ts;
// simplified 17/10/2026 — no more approval gate), without a database: the
// server layer applies exactly this to the roster rows.

let seq = 0;
const link = (apartmentNumber: string, name: string | null, role: PortalRole = 'owner'): IdentityLink =>
  ({ rosterId: `r${(seq += 1)}`, apartmentNumber, role, name });

describe('normalizeOwnerName', () => {
  it('trims and collapses whitespace; empty is null', () => {
    expect(normalizeOwnerName('  דנה   לוי ')).toBe('דנה לוי');
    expect(normalizeOwnerName('דנה\tלוי')).toBe('דנה לוי');
    expect(normalizeOwnerName('   ')).toBeNull();
    expect(normalizeOwnerName(null)).toBeNull();
    expect(normalizeOwnerName(undefined)).toBeNull();
  });
});

describe('decidePortalIdentity — who the phone is', () => {
  it('no active link → no identity at all', () => {
    expect(decidePortalIdentity([])).toBeNull();
  });

  it('one apartment is never blocked — even with no name', () => {
    expect(decidePortalIdentity([link('520', 'טלי אראל')])).toMatchObject({ name: 'טלי אראל' });
    expect(decidePortalIdentity([link('520', null, 'tenant')])).toMatchObject({ name: null });
  });

  it('several apartments under the same name (after whitespace) → one person, whatever the ROLES', () => {
    const id = decidePortalIdentity([link('1237', ' רונן  משולם', 'tenant'), link('1210', 'רונן משולם', 'owner')]);
    expect(id).toMatchObject({ name: 'רונן משולם' });
    expect(id!.apartments.map((a) => [a.apartmentNumber, a.role])).toEqual([['1210', 'owner'], ['1237', 'tenant']]);
  });

  it('every role sees the apartment debt and the building figures (Bllink has no payer marker)', () => {
    const id = decidePortalIdentity([link('1', 'דנה', 'owner'), link('2', 'דנה', 'tenant'), link('3', 'דנה', 'operator')]);
    expect(id).not.toBeNull();
    expect(id!.apartments.every((a) => a.canSeeDebt)).toBe(true);
    expect(id!.canSeeBuildingFinance).toBe(true);
  });

  it('several apartments under DIFFERENT names never withhold access (17/10/2026, "פישוט גישת פורטל")', () => {
    const id = decidePortalIdentity([link('1210', 'רונן משולם'), link('1237', "אלי אברג'יל"), link('520', 'טלי אראל')]);
    expect(id?.apartments.map((a) => a.apartmentNumber)).toEqual(['520', '1210', '1237']);
    expect(id?.canSeeBuildingFinance).toBe(true);
    // The greeting name is cosmetic only: the first apartment (by number)
    // whose record carries one — it never decides what is visible.
    expect(id?.name).toBe('טלי אראל');
  });

  it('a nameless record among several apartments still opens all of them — the name comes from the one that has it', () => {
    const id1 = decidePortalIdentity([link('1323', null), link('1324', 'שפייזר אייל')]);
    expect(id1?.apartments.map((a) => a.apartmentNumber)).toEqual(['1323', '1324']);
    expect(id1?.name).toBe('שפייזר אייל');

    const id2 = decidePortalIdentity([link('1', null), link('2', null)]);
    expect(id2?.apartments).toHaveLength(2);
    expect(id2?.name).toBeNull();
  });

  it('the reporter files under the lowest apartment OWNED, then operated, then rented — same name', () => {
    // owner in 1210 + tenant in 730 → 1210 as owner (not the lower 730)
    const id = decidePortalIdentity([link('1210', 'רונן', 'owner'), link('730', 'רונן', 'tenant')]);
    expect(id?.reporter).toMatchObject({ apartmentNumber: '1210', role: 'owner', name: 'רונן' });
    expect(id?.name).toBe(id?.reporter.name);
    // the lowest owned, numerically
    expect(decidePortalIdentity([link('1210', 'ר', 'owner'), link('926', 'ר', 'owner'), link('730', 'ר', 'tenant')])
      ?.reporter).toMatchObject({ apartmentNumber: '926', role: 'owner' });
    // no ownership → the lowest operated, before a lower rented one
    expect(decidePortalIdentity([link('1424', 'ר', 'operator'), link('1006', 'ר', 'operator'), link('730', 'ר', 'tenant')])
      ?.reporter).toMatchObject({ apartmentNumber: '1006', role: 'operator' });
    // only rented → the lowest rented
    expect(decidePortalIdentity([link('1001', 'ר', 'tenant'), link('520', 'ר', 'tenant')])
      ?.reporter).toMatchObject({ apartmentNumber: '520', role: 'tenant' });
  });
});

describe('identity helpers', () => {
  it('apartments sort as numbers, non-numeric last', () => {
    expect(['1001', 'B', '520', '7'].sort(compareApartmentNumbers)).toEqual(['7', '520', '1001', 'B']);
  });
  it('the roles read in a fixed order, each once', () => {
    expect(rolesLabel(['tenant', 'owner', 'tenant'])).toBe('בעלים · שוכר');
    expect(rolesLabel(['operator'])).toBe('מפעיל');
  });
});

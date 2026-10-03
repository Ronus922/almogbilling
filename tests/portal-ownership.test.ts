import { describe, expect, it } from 'vitest';
import { normalizeOwnerName } from '@/lib/portal/ownership';
import {
  compareApartmentNumbers, decidePortalIdentity, PORTAL_UNIDENTIFIED_NAME, rolesLabel,
  type IdentityApproval, type IdentityLink, type PortalRole,
} from '@/lib/portal/identity';
import { classifyBlockedPhone } from '@/lib/portal/blockedClassify';

// The portal's ONE identity decision (03/10/2026, lib/portal/identity.ts) and
// the blocked-phones classifier, without a database: the server layer applies
// exactly these to the roster rows.

let seq = 0;
const link = (apartmentNumber: string, name: string | null, role: PortalRole = 'owner'): IdentityLink =>
  ({ rosterId: `r${(seq += 1)}`, apartmentNumber, role, name });
const approval = (displayName: string, names: string[]): IdentityApproval => ({ id: 'a1', displayName, names });

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
    expect(decidePortalIdentity([], null)).toBeNull();
  });

  it('one apartment is never blocked — even with no name', () => {
    expect(decidePortalIdentity([link('520', 'טלי אראל')], null)).toMatchObject({ status: 'ok', name: 'טלי אראל' });
    expect(decidePortalIdentity([link('520', null, 'tenant')], null)).toMatchObject({ status: 'ok', name: null });
  });

  it('several apartments under the same name (after whitespace) → one person, whatever the ROLES', () => {
    const id = decidePortalIdentity([link('1237', ' רונן  משולם', 'tenant'), link('1210', 'רונן משולם', 'owner')], null);
    expect(id).toMatchObject({ status: 'ok', name: 'רונן משולם' });
    expect(id!.apartments.map((a) => [a.apartmentNumber, a.role])).toEqual([['1210', 'owner'], ['1237', 'tenant']]);
  });

  it('every role sees the apartment debt and the building figures (Bllink has no payer marker)', () => {
    const id = decidePortalIdentity([link('1', 'דנה', 'owner'), link('2', 'דנה', 'tenant'), link('3', 'דנה', 'operator')], null);
    expect(id?.status).toBe('ok');
    if (id?.status !== 'ok') return;
    expect(id.apartments.every((a) => a.canSeeDebt)).toBe(true);
    expect(id.canSeeBuildingFinance).toBe(true);
  });

  it('different names and no approval → BLOCKED: no name, no apartment, an unidentified reporter', () => {
    const id = decidePortalIdentity([link('1210', 'רונן משולם'), link('1237', "אלי אברג'יל"), link('520', 'טלי אראל')], null);
    expect(id).toEqual({
      status: 'blocked', name: null, apartments: [], canSeeBuildingFinance: false, approvalId: null,
      reporter: { rosterId: null, apartmentNumber: null, role: null, name: PORTAL_UNIDENTIFIED_NAME },
    });
  });

  it('an approval covering every name → one person under the approved name; a name added later → blocked again', () => {
    const links = [link('1030', 'ס נ נדל״ן'), link('1418', 'סוניה', 'operator')];
    const a = approval('סוניה (ס.נ נדל״ן)', ['ס נ נדל״ן', 'סוניה']);
    expect(decidePortalIdentity(links, a)).toMatchObject({ status: 'ok', name: 'סוניה (ס.נ נדל״ן)', approvalId: 'a1' });
    expect(decidePortalIdentity([...links, link('706', 'מישהו אחר')], a)?.status).toBe('blocked');
  });

  it('a nameless record among several apartments → blocked, and no approval can cover it', () => {
    expect(decidePortalIdentity([link('1323', null), link('1324', 'שפייזר אייל')], null)?.status).toBe('blocked');
    expect(decidePortalIdentity([link('1', null), link('2', null)], null)?.status).toBe('blocked');
    expect(decidePortalIdentity([link('1', '  '), link('2', 'דנה')], approval('דנה', ['', 'דנה']))?.status).toBe('blocked');
  });

  it('the reporter is the LOWEST apartment number, with the role held there and the same name', () => {
    const id = decidePortalIdentity([link('1001', 'דנה', 'owner'), link('520', 'דנה', 'tenant')], null);
    expect(id?.reporter).toMatchObject({ apartmentNumber: '520', role: 'tenant', name: 'דנה' });
    expect(id?.name).toBe(id?.reporter.name);
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

describe('classifyBlockedPhone — a suggestion for the blocked-phones screen', () => {
  it('reads the five kinds', () => {
    expect(classifyBlockedPhone(['יוסי פרידמן', 'פרידמן יוסי'])).toBe('spelling');
    expect(classifyBlockedPhone(['נזיה חורי', 'נזהי חורי'])).toBe('spelling');
    expect(classifyBlockedPhone(['ס.נ נדל״ן', 'סוניה'])).toBe('company_contact');
    expect(classifyBlockedPhone(['ליאורה מעיין', 'יעקב מעיין'])).toBe('family');
    expect(classifyBlockedPhone(['רונן משולם', 'טלי אראל'])).toBe('unrelated');
    expect(classifyBlockedPhone(['דנה', null])).toBe('missing_name');
  });
  it('"a different person" at entry makes it a suspected typing mistake', () => {
    expect(classifyBlockedPhone(['יוסי פרידמן', 'פרידמן יוסי'], true)).toBe('unrelated');
  });
  it('short words must match exactly; "בן" is a name, not a family word', () => {
    expect(classifyBlockedPhone(['לי כהן', 'לוי כהן'])).toBe('family');
    expect(classifyBlockedPhone(['בן הרוש', 'משה דיין'])).toBe('unrelated');
  });
  it('three names that hang together through the middle one are not "unrelated"', () => {
    expect(classifyBlockedPhone(['אלירן סלע', 'דוריס סלע בינימין', 'דוריס'])).not.toBe('unrelated');
  });
});

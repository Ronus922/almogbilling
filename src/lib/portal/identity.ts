// THE identity of a verified portal phone (03/10/2026, "זהות אחידה"; simplified
// 17/10/2026, "פישוט גישת פורטל" — see decisions log).
//
// One decision, made here and nowhere else, for everything the portal says
// about the person behind a phone: the name it greets them by, the apartments
// and the ROLE in each, and what each role may see. The portal header,
// "החשבון שלי", the fault report and every /api/portal endpoint read it
// through lib/db/portal/identity.ts — none of them works a name or a
// permission out on its own.
//
// The input is the phone's ACTIVE links (apartment_owner_phones: apartment,
// role, the name on the record that carries the phone). The rule:
//
//   • no active link → no identity (the session guard already refused);
//   • otherwise → access to EVERY linked apartment, unconditionally. Until
//     17/10/2026 several apartments under different names (or a link with no
//     name) blocked the phone pending a staff "אדם אחד" approval — that gate
//     is gone: contacts is the only source of truth, and a roster link is
//     never second-guessed by a name mismatch.
//   • the greeting name is the first name found, apartment-number order —
//     cosmetic only (it never affects which apartments are visible).
//
// Isomorphic and pure: the server layer applies it to the rows, the tests
// apply it directly.

import { normalizeOwnerName } from './ownership';

export type PortalRole = 'owner' | 'tenant' | 'operator';

export const PORTAL_ROLES: readonly PortalRole[] = ['owner', 'tenant', 'operator'];

/** The tag beside each apartment ("החשבון שלי", the header, the staff strip). */
export const PORTAL_ROLE_LABEL: Record<PortalRole, string> = {
  owner: 'בעלים',
  tenant: 'שוכר',
  operator: 'מפעיל',
};

/**
 * Who sees the apartment's charges and debt.
 *
 * Owners always. Tenants and operators: Bllink exposes no "who pays the
 * apartment" marker — its resident list carries, per person, only the role,
 * the name, the phone, the address, isPrimary (a contact flag up to three
 * people of one apartment carry, owners and renters together) and isActive
 * (Phase 0, 03/10/2026). So the rule chosen is the one for that case: everyone
 * registered in the apartment in one of the three roles sees its debt. There
 * is no manual "payer" field. A table and not a constant `true`, so a payer
 * marker, should Bllink ever add one, changes this line and nothing else.
 */
export const ROLE_SEES_APARTMENT_DEBT: Record<PortalRole, boolean> = {
  owner: true,
  tenant: true,
  operator: true,
};

/** One active link of the phone. */
export interface IdentityLink {
  rosterId: string;
  apartmentNumber: string;
  role: PortalRole;
  /** The name on the record that carries the phone (any role). */
  name: string | null;
}

export interface PortalApartmentAccess {
  apartmentNumber: string;
  role: PortalRole;
  rosterId: string;
  /** The apartment's charges and debt ("החשבון שלי", the dark card). */
  canSeeDebt: boolean;
}

export interface PortalReporterIdentity {
  rosterId: string;
  apartmentNumber: string;
  role: PortalRole;
  /** null when no record behind the phone carries a name. */
  name: string | null;
}

export interface PortalIdentity {
  /** null when no record behind the phone carries a name. */
  name: string | null;
  /** Every apartment, lowest number first, with the role and what it sees. */
  apartments: PortalApartmentAccess[];
  /** The building's figures (transparency module): every role. */
  canSeeBuildingFinance: true;
  reporter: PortalReporterIdentity;
}

/** Numeric apartment order: '520' before '1001'; a non-numeric one after
 *  every numeric one, then as text. */
export function compareApartmentNumbers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b) || a.localeCompare(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b);
}

/** Which apartment a fault report is filed under (03/10/2026): the lowest
 *  number the reporter OWNS; none → the lowest they operate; none → the
 *  lowest they rent. A report already filed keeps its snapshot. */
const REPORTER_ROLE_ORDER: readonly PortalRole[] = ['owner', 'operator', 'tenant'];

/** The decision. null = no active link at all. */
export function decidePortalIdentity(links: ReadonlyArray<IdentityLink>): PortalIdentity | null {
  if (links.length === 0) return null;
  const sorted = [...links].sort(
    (a, b) => compareApartmentNumbers(a.apartmentNumber, b.apartmentNumber) || a.rosterId.localeCompare(b.rosterId),
  );
  // The greeting name: the first apartment (by number) whose record carries
  // one. Cosmetic only — several apartments under different names (a
  // management company, a spelling) never withhold access.
  const name = sorted.map((l) => normalizeOwnerName(l.name)).find((n): n is string => n !== null) ?? null;

  const filedUnder = REPORTER_ROLE_ORDER
    .map((role) => sorted.find((l) => l.role === role))
    .find((l): l is IdentityLink => l !== undefined) ?? sorted[0];
  return {
    name,
    apartments: sorted.map((l) => ({
      apartmentNumber: l.apartmentNumber,
      role: l.role,
      rosterId: l.rosterId,
      canSeeDebt: ROLE_SEES_APARTMENT_DEBT[l.role],
    })),
    canSeeBuildingFinance: true,
    reporter: {
      rosterId: filedUnder.rosterId,
      apartmentNumber: filedUnder.apartmentNumber,
      role: filedUnder.role,
      // A record with no name still identifies the apartment; the issue then
      // reads "דיווח דייר · דירה 520 · בעלים".
      name,
    },
  };
}

/** "בעלים" / "בעלים · שוכר" — the distinct roles, in PORTAL_ROLES order. */
export function rolesLabel(roles: ReadonlyArray<PortalRole>): string {
  return PORTAL_ROLES.filter((r) => roles.includes(r)).map((r) => PORTAL_ROLE_LABEL[r]).join(' · ');
}

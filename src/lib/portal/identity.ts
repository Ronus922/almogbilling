// THE identity of a verified portal phone (03/10/2026, "זהות אחידה").
//
// One decision, made here and nowhere else, for everything the portal says
// about the person behind a phone: the name it greets them by, the apartments
// and the ROLE in each, what each role may see, and whether the phone is
// blocked. The portal header, "החשבון שלי", the fault report and every
// /api/portal endpoint read it through lib/db/portal/identity.ts — none of
// them works a name or a permission out on its own.
//
// The input is the phone's ACTIVE links (apartment_owner_phones: apartment,
// role, the name on the record that carries the phone) and its approved
// identity, if any. The rule:
//
//   • no active link → no identity (the session guard already refused);
//   • an approved identity whose names cover every name on the links → one
//     person: the approved display name;
//   • one apartment → one person: that link's name;
//   • several apartments, every link named and all the names equal after
//     whitespace normalisation → one person, whatever the ROLES (an owner in
//     one apartment and a tenant in another is no conflict);
//   • anything else → BLOCKED: different names and no approval that covers
//     them, or a link with no name. A nameless record cannot be approved
//     away — it stays blocked until the name is filled in on the card. A
//     blocked phone is greeted "שלום" with no name — never the name of any
//     record — sees no figure, and reports a fault as "לא מזוהה" with no
//     apartment.
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

/** The phone's approved identity (portal_identity_approvals, status approved). */
export interface IdentityApproval {
  id: string;
  displayName: string;
  /** The whitespace-normalised names the approval covers (never '' — a
   *  nameless record cannot be approved). */
  names: readonly string[];
}

export interface PortalApartmentAccess {
  apartmentNumber: string;
  role: PortalRole;
  rosterId: string;
  /** The apartment's charges and debt ("החשבון שלי", the dark card). */
  canSeeDebt: boolean;
}

export interface PortalReporterIdentity {
  rosterId: string | null;
  apartmentNumber: string | null;
  role: PortalRole | null;
  /** "לא מזוהה" for a blocked phone; null when the one record carries no name. */
  name: string | null;
}

export type PortalIdentity =
  | {
      status: 'ok';
      /** null when the one record behind the phone carries no name. */
      name: string | null;
      /** Every apartment, lowest number first, with the role and what it sees. */
      apartments: PortalApartmentAccess[];
      /** The building's figures (transparency module): every role, never a blocked phone. */
      canSeeBuildingFinance: true;
      /** Set when the phone is one person by approval, not by matching names. */
      approvalId: string | null;
      reporter: PortalReporterIdentity;
    }
  | {
      status: 'blocked';
      name: null;
      apartments: [];
      canSeeBuildingFinance: false;
      approvalId: null;
      reporter: PortalReporterIdentity;
    };

/** The reporter name of a fault from a blocked phone. The phone stays in
 *  reporter_phone, served only to staff with contacts:view. */
export const PORTAL_UNIDENTIFIED_NAME = 'לא מזוהה';

/** Numeric apartment order: '520' before '1001'; a non-numeric one after
 *  every numeric one, then as text. */
export function compareApartmentNumbers(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b) || a.localeCompare(b);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b);
}

/** The key a name is compared and approved by: whitespace-normalised, '' for none. */
export function identityNameKey(name: string | null | undefined): string {
  return normalizeOwnerName(name) ?? '';
}

/** The decision. null = no active link at all. */
export function decidePortalIdentity(
  links: ReadonlyArray<IdentityLink>,
  approval: IdentityApproval | null,
): PortalIdentity | null {
  if (links.length === 0) return null;
  const sorted = [...links].sort(
    (a, b) => compareApartmentNumbers(a.apartmentNumber, b.apartmentNumber) || a.rosterId.localeCompare(b.rosterId),
  );
  const keys = sorted.map((l) => identityNameKey(l.name));
  const apartmentCount = new Set(sorted.map((l) => l.apartmentNumber)).size;

  let name: string | null | undefined;
  let approvalId: string | null = null;
  if (approval && keys.every((k) => k !== '' && approval.names.includes(k))) {
    name = normalizeOwnerName(approval.displayName);
    approvalId = approval.id;
  } else if (apartmentCount === 1) {
    name = normalizeOwnerName(sorted[0].name);
  } else if (keys.every((k) => k !== '') && new Set(keys).size === 1) {
    name = keys[0];
  }

  if (name === undefined) {
    return {
      status: 'blocked',
      name: null,
      apartments: [],
      canSeeBuildingFinance: false,
      approvalId: null,
      reporter: { rosterId: null, apartmentNumber: null, role: null, name: PORTAL_UNIDENTIFIED_NAME },
    };
  }

  const first = sorted[0];
  return {
    status: 'ok',
    name,
    apartments: sorted.map((l) => ({
      apartmentNumber: l.apartmentNumber,
      role: l.role,
      rosterId: l.rosterId,
      canSeeDebt: ROLE_SEES_APARTMENT_DEBT[l.role],
    })),
    canSeeBuildingFinance: true,
    approvalId,
    reporter: {
      rosterId: first.rosterId,
      apartmentNumber: first.apartmentNumber,
      role: first.role,
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

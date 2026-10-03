// Owners-portal types shared by the server layer, the routes and the UI.
import type { PortalEventType, PortalLockoutReason } from '@/lib/constants/portal';
import type { PortalRole } from '@/lib/portal/identity';
import type { BlockedPhoneCategory } from '@/lib/portal/blockedClassify';

/** Which owner record carries a roster phone (migration 20261003095149). */
export type OwnerPhoneSource = 'contacts' | 'contact_people';

/** A row of the roster, as the apartment card's "טלפון ← דירות בפורטל" shows
 *  it: the phone, the record that links it, and what else the phone opens. */
export interface OwnerPhone {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  /** The role the phone holds in this apartment (migration 20261003161745). */
  role: PortalRole;
  phone_e164: string;
  is_active: boolean;
  created_at: string;
  /** The record that carries the phone today; null = none does (inactive). */
  source_table: OwnerPhoneSource | null;
  /** The name ON that record, read live. */
  source_name: string | null;
  /** A deliberate detach (admin / clean-up / owner replaced); null otherwise. */
  detached_at: string | null;
  detach_reason: string | null;
  /** The phone's OTHER active apartments, numeric order. */
  other_apartments: string[];
  /** The phone is BLOCKED (lib/portal/identity.ts) — the portal shows it no
   *  financial data until the names agree or an identity is approved. */
  blocked: boolean;
}

/** How a person is connected to one apartment of an approved identity. */
export type IdentityRelation = 'personal' | 'company_authorized' | 'family';

export const IDENTITY_RELATION_LABEL: Record<IdentityRelation, string> = {
  personal: 'אישי',
  company_authorized: 'מורשה של חברה',
  family: 'קרוב משפחה',
};

/** One phone the portal blocks (lib/portal/identity.ts), as the
 *  "טלפונים חסומים" screen shows it. */
export interface BlockedPortalPhone {
  phone_e164: string;
  /** The classifier's suggestion (lib/portal/blockedClassify.ts) — never a decision. */
  category: BlockedPhoneCategory;
  links: {
    id: string;
    apartment_number: string;
    owner_name: string | null;
    role: PortalRole;
    source_table: OwnerPhoneSource | null;
  }[];
  /** A "same person" request waiting for portal_manage (from the apartment card). */
  pending: { id: string; requested_by_name: string | null; requested_at: string } | null;
  /** Someone answered "a different person" when the phone was typed in. */
  flagged: boolean;
}

/** An identity in force — on the same screen, so it can be revoked. */
export interface ApprovedPortalIdentity {
  id: string;
  phone_e164: string;
  display_name: string;
  names: string[];
  apartments: { apartment_number: string; relation: IdentityRelation }[];
  decided_by_name: string | null;
  decided_at: string;
}

/** The entry warning: a phone typed onto an apartment card that another
 *  apartment already carries under another name. */
export interface PhoneEntryConflict {
  phone_e164: string;
  apartment_number: string;
  /** The name the card gives the phone (null = none typed). */
  entered_name: string | null;
  role: PortalRole;
  /** Where else the phone is registered, lowest apartment first. */
  others: { apartment_number: string; name: string | null; role: PortalRole }[];
}

/** The answer to one conflict. `identity` is required for "same" from a user
 *  with portal_manage (the approval is made there and then). */
export interface PhoneEntryDecision {
  phone_e164: string;
  decision: 'same' | 'different';
  identity?: {
    display_name: string;
    apartments: { apartment_number: string; relation: IdentityRelation }[];
  };
}

export interface PortalLockout {
  id: string;
  phone_e164: string;
  locked_until: string;
  tier: number;
  reason: PortalLockoutReason;
  created_at: string;
  released_at: string | null;
}

/** One line of the login log. `owner_name` is joined from the roster, so an
 *  attempt from an unknown phone carries null and the screen shows "—". */
export interface PortalLoginEvent {
  id: string;
  phone_e164: string;
  apartment_numbers: string[];
  event_type: PortalEventType;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  owner_name: string | null;
}

export interface PortalLogFilters {
  apartment?: string;
  phone?: string;
  eventType?: PortalEventType;
  from?: string;
  to?: string;
  limit?: number;
}

/** "החשבון שלי" — one apartment of the signed-in owner, as the portal shows
 *  it (src/lib/db/portal/account.ts): the six figures and nothing else. An
 *  archived debtors row is shown exactly like a live one (decision
 *  28/09/2026), so no status of any kind travels here. Amounts are exact
 *  (agorot included); the screen rounds them. */
export interface PortalAccount {
  apartment_number: string;
  /** The role the signed-in phone holds in this apartment (the tag). */
  role: PortalRole;
  /** The signed-in person's name — the portal identity's (null when unknown). */
  owner_display_name: string | null;
  total_debt: number;
  management_fees: number;
  hot_water_debt: number;
  /** The CRM's monthly-charge text as is (e.g. "3/26"), or null. */
  monthly_debt: string | null;
  /** Free text from the CRM (hot-water periods etc.), or null. */
  details: string | null;
  /** When the debt figures were last refreshed from Bllink (ISO), or null. */
  synced_at: string | null;
}

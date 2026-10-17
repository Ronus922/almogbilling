// Owners-portal types shared by the server layer, the routes and the UI.
import type { PortalEventType, PortalLockoutReason } from '@/lib/constants/portal';
import type { PortalRole } from '@/lib/portal/identity';

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
}

/** Which transport carries the OTP — SMS once a provider is configured,
 *  WhatsApp as the always-live fallback (lib/portal/otpChannel.ts). */
export type OtpChannel = 'sms' | 'whatsapp';

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

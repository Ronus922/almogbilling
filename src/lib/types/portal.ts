// Owners-portal types shared by the server layer, the routes and the UI.
import type { PortalEventType, PortalLockoutReason } from '@/lib/constants/portal';

/** A row of the roster, as the apartment card's "בעלי דירה" tab shows it. */
export interface OwnerPhone {
  id: string;
  apartment_number: string;
  owner_name: string | null;
  phone_e164: string;
  is_active: boolean;
  created_at: string;
}

/** Who a phone is, resolved from the roster at login time. */
export interface OwnerIdentity {
  /** Every apartment this phone owns — several is normal. */
  apartmentNumbers: string[];
  /** The first non-empty owner_name across those rows, for the log. */
  ownerName: string | null;
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

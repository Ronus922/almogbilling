// Access-chip domain types (migration 072). contacts (071) is the apartment
// registry / single source of truth — chips.contact_id points at it, and
// apartment_number / holder_* are snapshots taken at issuance, never runtime
// joins. Closed rules: no DELETE, chip_number never editable, the only way back
// is inactive -> active (reactivate).

export type ChipType = 'physical' | 'app';

export type ChipStatus = 'active' | 'inactive';

export type ChipResidentRole = 'owner' | 'tenant' | 'operator' | 'staff' | 'other';

export type ChipDeactivationReason =
  | 'lost'
  | 'stolen'
  | 'damaged'
  | 'returned'
  | 'moved_out'
  | 'unknown';

export type ChipEventType =
  | 'issued'
  | 'deactivated'
  | 'reactivated'
  | 'reassigned'
  | 'note'
  | 'controller_synced';

// List filter tabs: all · active · inactive · pending_sync (inactive +
// controller_synced=false) · app (chip_type='app').
export type ChipTab = 'all' | 'active' | 'inactive' | 'pending_sync' | 'app';

export type AppPlatform = 'ios' | 'android' | 'unknown';

export type AppInviteStatus = 'pending' | 'active' | 'expired';

export interface Chip {
  id: string;
  chip_number: string;
  chip_type: ChipType;
  contact_id: string;
  /** Display snapshot taken at issuance/reassignment — never joined at runtime. */
  apartment_number: string;
  status: ChipStatus;
  /** NOT NULL since 074 — a chip is always issued on a specific person's name. */
  resident_role: ChipResidentRole;
  /** Issuance snapshot ("on whose name it was issued") — the DISPLAY name is
   *  resolved via resolveChipHolder(), never read directly by the UI. */
  holder_name: string | null;
  holder_phone: string | null;
  issued_at: string;
  issued_by: string | null;
  issued_by_name: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivated_by_name: string | null;
  deactivation_reason: ChipDeactivationReason | null;
  controller_synced: boolean;
  controller_synced_at: string | null;
  app_platform: AppPlatform | null;
  app_invite_status: AppInviteStatus | null;
  app_expires_at: string | null;
  issuance_fee: number | null;
  fee_charged: boolean;
  limit_override_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of a chip's append-only audit trail (chip_events). */
export interface ChipEvent {
  id: string;
  chip_id: string;
  event_type: ChipEventType;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface ChipsKpis {
  active: number;
  app_active: number;
  lost_30d: number;
  apartments_without_active: number;
  /** Total apartments in the registry (unit_type='apartment') — the KPI's denominator. */
  apartments_total: number;
  pending_controller: number;
}

export interface ChipListFilters {
  tab?: ChipTab;
  status?: ChipStatus;
  chip_type?: ChipType;
  contact_id?: string;
  q?: string;
}

/** Which field a search result matched on (priority order). */
export type ChipMatchType = 'chip_number' | 'apartment' | 'holder_name';

/** Read-time holder resolution (074) — every chip read LEFT JOINs contacts and
 *  carries the LIVE registry name/phone for its resident_role. The UI never
 *  reads holder_name directly; it goes through resolveChipHolder() over these. */
export interface ChipWithHolder extends Chip {
  /** contacts.{role}_name at read time; null for snapshot roles (other/staff). */
  live_holder_name: string | null;
  live_holder_phone: string | null;
  /** How many chips this same person holds — (contact_id, resident_role), and
   *  for snapshot roles also the same holder_name. */
  holder_chip_count: number;
  /** Set only when the list query ran with a search term. */
  match_type?: ChipMatchType | null;
}

/** One holder group inside a multi-person issue request: one person (role +
 *  snapshot name/phone) receiving 1-5 NEW chip numbers of one chip_type.
 *  The UI splits a mixed-type holder block into one group per type — the
 *  soft-limit is still counted over the SUM of all groups together. */
export interface IssueChipGroup {
  /** Required (074): owner/tenant/operator snapshot from the registry;
   *  other/staff require holder_name in the payload. */
  resident_role: ChipResidentRole;
  holder_name?: string | null;
  holder_phone?: string | null;
  chip_type: ChipType;
  /** 1-5 NEW chip numbers for this person. */
  numbers: string[];
  app_platform?: AppPlatform | null;
  app_invite_status?: AppInviteStatus | null;
  app_expires_at?: string | null;
  /** Optional per-group overrides of the window-global fee fields. */
  issuance_fee?: number | null;
  fee_charged?: boolean | null;
}

/** Payload for issuing chips — one apartment, one or more holder groups, ONE
 *  transaction, all-or-nothing. Fee/notes/override are window-global (a group
 *  may override its fee fields). */
export interface IssueChipsInput {
  contact_id: string;
  groups: IssueChipGroup[];
  issuance_fee?: number | null;
  fee_charged?: boolean;
  notes?: string | null;
  /** Required (non-empty) when existing actives + ALL new numbers exceed the
   *  soft limit of 4 active chips per contact. */
  limit_override_reason?: string | null;
}

/** One of the three inline resident slots of a contacts row (owner/tenant/operator).
 *  exists = both name AND phone are non-empty after trim. */
export interface ContactResidentCard {
  role: 'owner' | 'tenant' | 'operator';
  name: string | null;
  phone: string | null;
  exists: boolean;
}

export interface ContactResidents {
  contact_id: string;
  apartment_number: string;
  unit_type: string;
  resident_type: string;
  residents: ContactResidentCard[];
}

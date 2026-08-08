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
  resident_role: ChipResidentRole | null;
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
  pending_controller: number;
}

export interface ChipListFilters {
  tab?: ChipTab;
  status?: ChipStatus;
  chip_type?: ChipType;
  contact_id?: string;
  q?: string;
}

/** Payload for issuing chips — up to 5 chip numbers in one request, all-or-nothing. */
export interface IssueChipInput {
  contact_id: string;
  chip_type: ChipType;
  chip_numbers: string[];
  resident_role?: ChipResidentRole | null;
  holder_name?: string | null;
  holder_phone?: string | null;
  app_platform?: AppPlatform | null;
  app_invite_status?: AppInviteStatus | null;
  app_expires_at?: string | null;
  issuance_fee?: number | null;
  fee_charged?: boolean;
  /** Required (non-empty) to exceed the soft limit of 4 active chips per contact. */
  limit_override_reason?: string | null;
  notes?: string | null;
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

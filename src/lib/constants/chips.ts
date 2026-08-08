// Chip label maps + enum value arrays. Client-safe (no server imports) — the
// arrays are the validation whitelists for API routes, the label maps are the
// Hebrew display vocabulary for the UI.
import type {
  ChipType,
  ChipStatus,
  ChipResidentRole,
  ChipDeactivationReason,
  ChipEventType,
  ChipTab,
  AppPlatform,
  AppInviteStatus,
} from '@/lib/types/chips';

// ── Enum value arrays (validation) ─────────────────────────────────────────

export const CHIP_TYPES: readonly ChipType[] = ['physical', 'app'];

export const CHIP_STATUSES: readonly ChipStatus[] = ['active', 'inactive'];

export const CHIP_RESIDENT_ROLES: readonly ChipResidentRole[] = [
  'owner',
  'tenant',
  'operator',
  'staff',
  'other',
];

export const CHIP_DEACTIVATION_REASONS: readonly ChipDeactivationReason[] = [
  'lost',
  'stolen',
  'damaged',
  'returned',
  'moved_out',
  'unknown',
];

export const CHIP_EVENT_TYPES: readonly ChipEventType[] = [
  'issued',
  'deactivated',
  'reactivated',
  'reassigned',
  'note',
  'controller_synced',
];

export const CHIP_TABS: readonly ChipTab[] = ['all', 'active', 'inactive', 'pending_sync', 'app'];

export const APP_PLATFORMS: readonly AppPlatform[] = ['ios', 'android', 'unknown'];

export const APP_INVITE_STATUSES: readonly AppInviteStatus[] = ['pending', 'active', 'expired'];

// ── Hebrew label maps ──────────────────────────────────────────────────────

export const CHIP_TYPE_LABEL: Record<ChipType, string> = {
  physical: 'פיזי',
  app: 'אפליקציה',
};

export const RESIDENT_ROLE_LABEL: Record<ChipResidentRole, string> = {
  owner: 'בעל דירה',
  tenant: 'שוכר',
  operator: 'מפעיל',
  staff: 'צוות',
  other: 'אחר',
};

export const DEACTIVATION_REASON_LABEL: Record<ChipDeactivationReason, string> = {
  lost: 'אבד',
  stolen: 'נגנב',
  damaged: 'ניזוק',
  returned: 'הוחזר',
  moved_out: 'עזב את הדירה',
  unknown: 'לא ידוע',
};

export const CHIP_EVENT_LABEL: Record<ChipEventType, string> = {
  issued: 'הונפק',
  deactivated: 'הושבת',
  reactivated: 'הופעל מחדש',
  reassigned: 'הועבר לדירה אחרת',
  note: 'עדכון פרטים',
  controller_synced: 'עודכן בבקר',
};

/** contacts.unit_type (071) display labels — the registry's unit taxonomy. */
export const UNIT_TYPE_LABEL: Record<string, string> = {
  apartment: 'דירה',
  storage: 'מחסן',
  parking: 'חניה',
  common: 'שטח משותף',
  staff: 'עובד',
  other: 'אחר',
};

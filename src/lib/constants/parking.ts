// Parking & Storage vocabulary.
//
// Pure constants shared by the validation layer, the db layer, the routes and
// the tenant form's חניות ומחסנים section.
//
// The 2015 document's transcribed figures used to live here too, alongside the
// summary screen that compared the data against them. Both are gone; the tables
// and the API remain. If that comparison comes back, it comes back with its own
// transcription — never derived from the rows it is checking.

import type {
  ParkingOwnerType,
  ParkingSaleStatus,
  ParkingSizeType,
} from '@/lib/types/parking';

// ── option lists (single source for validation + the Select controls) ────────

export const PARKING_OWNER_TYPES: readonly ParkingOwnerType[] = [
  'apartment', 'developer', 'committee',
];

export const PARKING_SIZE_TYPES: readonly ParkingSizeType[] = [
  'single', 'double_width', 'double_length',
];

export const PARKING_SALE_STATUSES: readonly ParkingSaleStatus[] = [
  'none', 'for_sale', 'in_process', 'sold',
];

export const OWNER_TYPE_LABEL: Record<ParkingOwnerType, string> = {
  apartment: 'דירה',
  developer: 'חוף הכרמל',
  committee: 'נציגות',
};

export const SIZE_TYPE_LABEL: Record<ParkingSizeType, string> = {
  single: 'רגילה',
  double_width: 'כפולה ברוחב',
  double_length: 'כפולה באורך',
};

/** The lot this module currently covers. lot_code exists so a second lot needs
 *  data, not a schema change. */
export const DEFAULT_LOT_CODE = '1P';

export const PARKING_NOTES_MAX = 2000;
export const STORAGE_UNIT_NUMBER_MAX = 40;
export const APARTMENT_NUMBER_MAX = 40;
export const DEACTIVATION_REASON_MAX = 500;
/** Lot 1P is numbered 1..187; the ceiling is loose on purpose so a re-survey
 *  does not need a migration, while still rejecting a typo like 99999. */
export const SPOT_NUMBER_MIN = 1;
export const SPOT_NUMBER_MAX = 9999;

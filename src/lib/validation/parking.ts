// Shared validation + coercion for the Parking & Storage module — used by every
// POST/PATCH route so create and update can never disagree (same contract as
// lib/validation/areas.ts).
//
// Pure: no DB, no server-only.
//
// The DB CHECK constraints of migration 076 are the last line of defence, not
// the first. A constraint violation surfaces as a Postgres 23514 and would
// reach the user as a 500 with an English constraint name — so every rule the
// DB enforces is ALSO enforced here, where it can be phrased in Hebrew and
// pointed at the field that caused it.

import type {
  ParkingOwnerType,
  ParkingSaleStatus,
  ParkingSizeType,
  ParkingSpotWritableFields,
  StorageUnitWritableFields,
} from '@/lib/types/parking';
import {
  APARTMENT_NUMBER_MAX,
  DEACTIVATION_REASON_MAX,
  DEFAULT_LOT_CODE,
  PARKING_NOTES_MAX,
  PARKING_OWNER_TYPES,
  PARKING_SALE_STATUSES,
  PARKING_SIZE_TYPES,
  SPOT_NUMBER_MAX,
  SPOT_NUMBER_MIN,
  STORAGE_UNIT_NUMBER_MAX,
} from '@/lib/constants/parking';

/** Stable machine codes — the client branches on these; the Hebrew below is
 *  what a human sees if it does not. */
export type ParkingErrorCode =
  | 'invalid_json'
  | 'spot_number_required'
  | 'spot_number_invalid'
  | 'spot_number_out_of_range'
  | 'unit_number_required'
  | 'unit_number_too_long'
  | 'lot_code_required'
  | 'owner_type_required'
  | 'owner_type_invalid'
  | 'size_type_invalid'
  | 'sale_status_invalid'
  | 'apartment_number_required'
  | 'apartment_number_not_allowed'
  | 'apartment_number_too_long'
  | 'apartment_not_found'
  | 'notes_too_long'
  | 'is_active_required'
  | 'reason_required'
  | 'reason_too_long'
  | 'spot_number_taken'
  | 'unit_number_taken'
  | 'not_found';

export const PARKING_ERROR_MESSAGE: Record<ParkingErrorCode, string> = {
  invalid_json: 'הבקשה אינה תקינה. רענן את העמוד ונסה שוב.',
  spot_number_required: 'יש להזין מספר חניה',
  spot_number_invalid: 'מספר חניה חייב להיות מספר שלם',
  spot_number_out_of_range: `מספר חניה חייב להיות בין ${SPOT_NUMBER_MIN} ל-${SPOT_NUMBER_MAX}`,
  unit_number_required: 'יש להזין מספר מחסן',
  unit_number_too_long: `מספר מחסן ארוך מדי (עד ${STORAGE_UNIT_NUMBER_MAX} תווים)`,
  lot_code_required: 'יש להזין קוד חניון',
  owner_type_required: 'יש לבחור שיוך',
  owner_type_invalid: 'שיוך לא תקין',
  size_type_invalid: 'גודל חניה לא תקין',
  sale_status_invalid: 'סטטוס מכירה לא תקין',
  apartment_number_required: 'יש להזין מספר דירה כששיוך = דירה',
  apartment_number_not_allowed: 'לחניה בבעלות חוף הכרמל או הנציגות אין מספר דירה',
  apartment_number_too_long: `מספר דירה ארוך מדי (עד ${APARTMENT_NUMBER_MAX} תווים)`,
  apartment_not_found: 'מספר הדירה אינו קיים ברשימת הדיירים',
  notes_too_long: `ההערה ארוכה מדי (עד ${PARKING_NOTES_MAX} תווים)`,
  is_active_required: 'יש לציין את הסטטוס המבוקש',
  reason_required: 'יש להזין סיבה לביטול ההפעלה',
  reason_too_long: `הסיבה ארוכה מדי (עד ${DEACTIVATION_REASON_MAX} תווים)`,
  spot_number_taken: 'מספר החניה כבר תפוס',
  unit_number_taken: 'מספר המחסן כבר תפוס',
  not_found: 'הרשומה לא נמצאה',
};

export function parkingErrorMessage(code: ParkingErrorCode): string {
  return PARKING_ERROR_MESSAGE[code];
}

export type ParkingValidation<T> =
  | { ok: true; fields: T }
  | { ok: false; code: ParkingErrorCode };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The one rule both tables share, and the one most likely to be got wrong:
 * "attached to an apartment" and "carries an apartment number" are the same
 * fact. Rejecting BOTH halves (a missing number on an apartment row AND a
 * stray number on a developer/committee row) mirrors the DB's equality CHECK —
 * a one-sided check would let the UI send a developer spot that silently kept
 * the apartment number from before the owner_type was switched.
 */
function coerceApartmentLink(
  ownerType: ParkingOwnerType,
  raw: unknown,
): { ok: true; apartment_number: string | null } | { ok: false; code: ParkingErrorCode } {
  const apartment = str(raw);
  if (ownerType === 'apartment') {
    if (!apartment) return { ok: false, code: 'apartment_number_required' };
    if (apartment.length > APARTMENT_NUMBER_MAX) {
      return { ok: false, code: 'apartment_number_too_long' };
    }
    return { ok: true, apartment_number: apartment };
  }
  if (apartment) return { ok: false, code: 'apartment_number_not_allowed' };
  return { ok: true, apartment_number: null };
}

function coerceOwnerType(
  raw: unknown,
): { ok: true; owner_type: ParkingOwnerType } | { ok: false; code: ParkingErrorCode } {
  const v = str(raw);
  if (!v) return { ok: false, code: 'owner_type_required' };
  if (!PARKING_OWNER_TYPES.includes(v as ParkingOwnerType)) {
    return { ok: false, code: 'owner_type_invalid' };
  }
  return { ok: true, owner_type: v as ParkingOwnerType };
}

function coerceNotes(
  raw: unknown,
): { ok: true; notes: string | null } | { ok: false; code: ParkingErrorCode } {
  const v = str(raw);
  if (v.length > PARKING_NOTES_MAX) return { ok: false, code: 'notes_too_long' };
  return { ok: true, notes: v || null };
}

/** Coerce arbitrary JSON into validated parking-spot fields. */
export function coerceAndValidateParkingSpot(
  body: Record<string, unknown>,
): ParkingValidation<ParkingSpotWritableFields> {
  // spot_number — accept a number or a numeric string (a form sends text).
  const rawSpot = body.spot_number;
  if (rawSpot === undefined || rawSpot === null || rawSpot === '') {
    return { ok: false, code: 'spot_number_required' };
  }
  const spotNum = typeof rawSpot === 'number' ? rawSpot : Number(str(rawSpot));
  if (!Number.isInteger(spotNum)) return { ok: false, code: 'spot_number_invalid' };
  if (spotNum < SPOT_NUMBER_MIN || spotNum > SPOT_NUMBER_MAX) {
    return { ok: false, code: 'spot_number_out_of_range' };
  }

  const lotRaw = str(body.lot_code);
  const lot_code = lotRaw || DEFAULT_LOT_CODE;
  if (!lot_code) return { ok: false, code: 'lot_code_required' };

  const sizeRaw = str(body.size_type) || 'single';
  if (!PARKING_SIZE_TYPES.includes(sizeRaw as ParkingSizeType)) {
    return { ok: false, code: 'size_type_invalid' };
  }

  const owner = coerceOwnerType(body.owner_type);
  if (!owner.ok) return owner;

  const link = coerceApartmentLink(owner.owner_type, body.apartment_number);
  if (!link.ok) return link;

  const saleRaw = str(body.sale_status) || 'none';
  if (!PARKING_SALE_STATUSES.includes(saleRaw as ParkingSaleStatus)) {
    return { ok: false, code: 'sale_status_invalid' };
  }

  const notes = coerceNotes(body.notes);
  if (!notes.ok) return notes;

  return {
    ok: true,
    fields: {
      lot_code,
      spot_number: spotNum,
      size_type: sizeRaw as ParkingSizeType,
      owner_type: owner.owner_type,
      apartment_number: link.apartment_number,
      sale_status: saleRaw as ParkingSaleStatus,
      notes: notes.notes,
    },
  };
}

/** Coerce arbitrary JSON into validated storage-unit fields. */
export function coerceAndValidateStorageUnit(
  body: Record<string, unknown>,
): ParkingValidation<StorageUnitWritableFields> {
  const unit_number = str(body.unit_number);
  if (!unit_number) return { ok: false, code: 'unit_number_required' };
  if (unit_number.length > STORAGE_UNIT_NUMBER_MAX) {
    return { ok: false, code: 'unit_number_too_long' };
  }

  const owner = coerceOwnerType(body.owner_type);
  if (!owner.ok) return owner;

  const link = coerceApartmentLink(owner.owner_type, body.apartment_number);
  if (!link.ok) return link;

  const notes = coerceNotes(body.notes);
  if (!notes.ok) return notes;

  return {
    ok: true,
    fields: {
      unit_number,
      owner_type: owner.owner_type,
      apartment_number: link.apartment_number,
      notes: notes.notes,
    },
  };
}

export interface ToggleActiveFields {
  is_active: boolean;
  /** Required when deactivating; ignored (null) when reactivating. */
  reason: string | null;
}

/**
 * Validate a toggle-active body. The reason is mandatory on the way DOWN only:
 * turning a spot back on needs no justification, turning it off destroys an
 * assignment and must say why (the DB agrees — see the
 * *_deactivation_reason_required CHECKs).
 */
export function coerceAndValidateToggleActive(
  body: Record<string, unknown>,
): ParkingValidation<ToggleActiveFields> {
  if (typeof body.is_active !== 'boolean') {
    return { ok: false, code: 'is_active_required' };
  }
  if (body.is_active) return { ok: true, fields: { is_active: true, reason: null } };

  const reason = str(body.reason);
  if (!reason) return { ok: false, code: 'reason_required' };
  if (reason.length > DEACTIVATION_REASON_MAX) {
    return { ok: false, code: 'reason_too_long' };
  }
  return { ok: true, fields: { is_active: false, reason } };
}

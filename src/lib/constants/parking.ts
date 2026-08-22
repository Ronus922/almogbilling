// Parking & Storage vocabulary + the frozen expectations of the source document.
//
// Pure constants. The figures here come from "הצמדת חניות לדירות" (14.5.2015)
// and are TRANSCRIBED, never computed — a summary screen that derived its
// expectations from the same rows it is checking would agree with itself by
// construction and catch nothing.

import type {
  ParkingFigures,
  ParkingOwnerType,
  ParkingSaleStatus,
  ParkingSizeType,
  ParkingSummaryCategory,
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

/** Compact form for table cells, where the full name does not fit. */
export const OWNER_TYPE_SHORT: Record<ParkingOwnerType, string> = {
  apartment: 'דירה',
  developer: 'חו״כ',
  committee: 'נציגות',
};

export const SIZE_TYPE_LABEL: Record<ParkingSizeType, string> = {
  single: 'רגילה',
  double_width: 'כפולה ברוחב',
  double_length: 'כפולה באורך',
};

export const SALE_STATUS_LABEL: Record<ParkingSaleStatus, string> = {
  none: '—',
  for_sale: 'למכירה',
  in_process: 'בתהליך מכירה',
  sold: 'נמכרה',
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

// ── the 2015 document ────────────────────────────────────────────────────────

/**
 * The seven apartments חוף הכרמל had NOT yet sold when the document was written.
 * Their spots are attached to an apartment but still developer-owned in
 * substance, which is why the document reports them as their own row.
 * Kept as apartment numbers (text — contacts.apartment_number is text).
 */
export const UNSOLD_DEVELOPER_APARTMENTS: readonly string[] = [
  '1341', '1407', '1440', '1539', '1619', '1620', '1628',
];

export const PARKING_CATEGORY_LABEL: Record<ParkingSummaryCategory, string> = {
  developer_sold_apartments:   'חו״כ — הוצמדו לדירות שנמכרו',
  developer_unsold_apartments: 'חו״כ — הוצמדו ל-7 דירות שטרם נמכרו',
  developer_retained:          'נותרו בבעלות חוף הכרמל',
  committee_sold:              'נמכרו ע״י הנציגות',
  committee_in_process:        'בתהליך מכירה ע״י הנציגות',
  committee_for_sale:          'נותרו לנציגות למכירה',
};

/** Document row order — the summary table renders in exactly this sequence. */
export const PARKING_CATEGORY_ORDER: readonly ParkingSummaryCategory[] = [
  'developer_sold_apartments',
  'developer_unsold_apartments',
  'developer_retained',
  'committee_sold',
  'committee_in_process',
  'committee_for_sale',
];

/**
 * Transcribed from the document's table. DO NOT recompute these from
 * parking_spots — the whole point is to disagree with the data when the data
 * is wrong.
 *
 * KNOWN, ACCEPTED MISMATCH (audit 2026-08-22): the seed carries 9 doubles, not
 * 14. The five missing markings are unrecoverable — the little 1/2/3 digits in
 * the source document's notes column did not survive OCR. The shortfall is 1 in
 * developer_sold_apartments and 4 in developer_retained, so those two rows plus
 * the total render ⚠️ against a correct seed. That is the screen working, not a
 * bug: do not "fix" the numbers on either side.
 */
export const PARKING_EXPECTED: Record<ParkingSummaryCategory, ParkingFigures> = {
  developer_sold_apartments:   { spots: 108, doubles: 4, places: 112 },
  developer_unsold_apartments: { spots: 14,  doubles: 1, places: 15  },
  developer_retained:          { spots: 35,  doubles: 9, places: 44  },
  committee_sold:              { spots: 8,   doubles: 0, places: 8   },
  committee_in_process:        { spots: 4,   doubles: 0, places: 4   },
  committee_for_sale:          { spots: 18,  doubles: 0, places: 18  },
};

/** The document's own bottom line, transcribed separately rather than summed —
 *  it is a stated fact of the source, and keeping it independent means a
 *  transcription slip in the six rows above cannot hide inside a total that
 *  was derived from them. */
export const PARKING_EXPECTED_TOTAL: ParkingFigures = {
  spots: 187,
  doubles: 14,
  places: 201,
};

export const PARKING_TOTAL_LABEL = 'סה״כ';

// Parking & Storage module ("חניות ומחסנים") domain types — building Almog,
// lot 1P. Backed by public.parking_spots + public.storage_units (migration 076).
//
// Pure types only: no DB, no server-only. Shared by the validation layer, the
// db layer, the routes and the client components.

// ── Shared vocabulary ────────────────────────────────────────────────────────

/** Who holds the spot/unit. 'developer' = חוף הכרמל ("חו״כ"), 'committee' = נציגות. */
export type ParkingOwnerType = 'apartment' | 'developer' | 'committee';

/**
 * The physical shape of a spot. A double spot is ONE row — the shape lives here
 * and `capacity` is derived from it in the DB (single → 1, either double → 2).
 * 'double_length' carries no rows in the 2015 seed (those markings were lost in
 * the document's OCR) but is a real category and must stay selectable.
 */
export type ParkingSizeType = 'single' | 'double_width' | 'double_length';

/** Where the spot is in a sale process. Tracked for parking only. */
export type ParkingSaleStatus = 'none' | 'for_sale' | 'in_process' | 'sold';

// ── parking_spots ────────────────────────────────────────────────────────────

export interface ParkingSpot {
  id: string;
  lot_code: string;
  spot_number: number;
  size_type: ParkingSizeType;
  /** DB-generated (1 or 2). Never written by the client. */
  capacity: number;
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
  sale_status: ParkingSaleStatus;
  notes: string | null;
  is_active: boolean;
  deactivated_at: Date | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

/** Fields a client may write (create or whole-object update). */
export interface ParkingSpotWritableFields {
  lot_code: string;
  spot_number: number;
  size_type: ParkingSizeType;
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
  sale_status: ParkingSaleStatus;
  notes: string | null;
}

export interface ParkingSpotFilters {
  owner_type?: ParkingOwnerType;
  apartment_number?: string;
  size_type?: ParkingSizeType;
  /** Free text over spot number / apartment number / notes. */
  q?: string;
  /** Default false — the list shows live allocation only. */
  includeInactive?: boolean;
}

// ── storage_units ────────────────────────────────────────────────────────────

export interface StorageUnit {
  id: string;
  unit_number: string;
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
  notes: string | null;
  is_active: boolean;
  deactivated_at: Date | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

export interface StorageUnitWritableFields {
  unit_number: string;
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
  notes: string | null;
}

export interface StorageUnitFilters {
  owner_type?: ParkingOwnerType;
  apartment_number?: string;
  q?: string;
  includeInactive?: boolean;
}

// ── by-apartment ─────────────────────────────────────────────────────────────

/** Everything one apartment holds. Used by the contacts panel + /parking tab 2. */
export interface ApartmentAssets {
  apartment_number: string;
  /** False when no contacts row carries this apartment_number. */
  apartment_exists: boolean;
  parking: ParkingSpot[];
  storage: StorageUnit[];
  /** Sum of parking capacity — a double counts as 2. */
  total_places: number;
}

// ── summary / validation against the 2015 document ───────────────────────────

/**
 * The six ownership-and-status buckets of the source document, in its own row
 * order. The keys name what the bucket MEANS, not how it is computed — see
 * PARKING_CATEGORY_LABEL and classification in lib/db/parking.ts.
 */
export type ParkingSummaryCategory =
  | 'developer_sold_apartments'
  | 'developer_unsold_apartments'
  | 'developer_retained'
  | 'committee_sold'
  | 'committee_in_process'
  | 'committee_for_sale';

/** The three figures the document reports for every bucket. */
export interface ParkingFigures {
  spots: number;
  doubles: number;
  places: number;
}

export interface ParkingSummaryRow {
  key: ParkingSummaryCategory;
  label: string;
  actual: ParkingFigures;
  /** Hard-coded from the 2015 document — never derived from the DB. */
  expected: ParkingFigures;
  /** True when all three figures match. Drives the ✅/⚠️ marker. */
  ok: boolean;
}

/**
 * Referential check that has nothing to do with the document: spots/units
 * pointing at an apartment_number with no contacts row. There is deliberately
 * no FK enforcing this (see migration 076), so it is checked here instead.
 * Audit 2026-08-22: 0. It must stay 0.
 */
export interface ParkingIntegrityCheck {
  orphan_parking_spots: number;
  orphan_storage_units: number;
  expected: 0;
  ok: boolean;
}

export interface ParkingSummaryKpis {
  parking_spots: number;
  parking_places: number;
  parking_doubles: number;
  storage_units: number;
  apartments_with_parking: number;
  apartments_with_storage: number;
}

export interface ParkingSummary {
  rows: ParkingSummaryRow[];
  total: ParkingSummaryRow;
  integrity: ParkingIntegrityCheck;
  kpis: ParkingSummaryKpis;
  /** True only when every row, the total AND the integrity check pass. */
  ok: boolean;
}

// The editable-row layer for parking spots and storage units.
//
// Two surfaces edit these tables — the חניות ומחסנים section of the tenant form
// and the /parking table — and they must agree on every rule that decides
// whether a number is legal and what happens when it is saved. Only the state
// management differs between them (a panel that saves on submit vs a cell that
// saves on blur), so only that stays in the components.
//
// Pure client-side: no server-only, no JSX. The functions here talk to the same
// /api/parking and /api/storage routes any other caller uses.
//
// THE RULE THIS FILE ENCODES: a spot or unit is ONE row for the life of the
// building. It is created once and then only ever changes owner. Removing it
// from an apartment is `save(row, RELEASED_OWNER)` — the same call as any other
// save, pointed at חוף הכרמל. Nothing here deactivates anything.

import { parkingTransferMessage } from '@/lib/parking/conflictMessage';
import { parkingErrorMessage } from '@/lib/validation/parking';
import {
  DEFAULT_LOT_CODE, SPOT_NUMBER_MAX, SPOT_NUMBER_MIN, STORAGE_UNIT_NUMBER_MAX,
} from '@/lib/constants/parking';
import type {
  ParkingOwnerType, ParkingSaleStatus, ParkingSizeType, ParkingSpot, StorageUnit,
} from '@/lib/types/parking';

// ── row model ────────────────────────────────────────────────────────────────

export interface ParkingRow {
  /** Client-only stable React key. */
  key: string;
  /** null → not saved yet (POST); otherwise PATCH. */
  id: string | null;
  lot_code: string;
  spot_number: string;
  size_type: ParkingSizeType;
  /** Not edited by either surface — carried so the whole-object PATCH cannot
   *  erase what the other one wrote. */
  sale_status: ParkingSaleStatus;
  notes: string | null;
}

export interface StorageRow {
  key: string;
  id: string | null;
  unit_number: string;
  notes: string | null;
}

/** Who a row belongs to. The two halves move together — the DB enforces
 *  `(owner_type = 'apartment') = (apartment_number is not null)`. */
export interface AssetOwner {
  owner_type: ParkingOwnerType;
  apartment_number: string | null;
}

export function apartmentOwner(apartmentNumber: string): AssetOwner {
  return { owner_type: 'apartment', apartment_number: apartmentNumber.trim() };
}

/** Where a row goes when it is removed from an apartment without a new one:
 *  back to חוף הכרמל, number intact, still active. */
export const RELEASED_OWNER: AssetOwner = { owner_type: 'developer', apartment_number: null };

export function parkingRowOf(spot: ParkingSpot): ParkingRow {
  return {
    key: `saved-p-${spot.id}`,
    id: spot.id,
    lot_code: spot.lot_code,
    spot_number: String(spot.spot_number),
    size_type: spot.size_type,
    sale_status: spot.sale_status,
    notes: spot.notes,
  };
}

export function storageRowOf(unit: StorageUnit): StorageRow {
  return {
    key: `saved-s-${unit.id}`,
    id: unit.id,
    unit_number: unit.unit_number,
    notes: unit.notes,
  };
}

export function blankParkingRow(key: string): ParkingRow {
  return {
    key, id: null, lot_code: DEFAULT_LOT_CODE, spot_number: '',
    size_type: 'single', sale_status: 'none', notes: null,
  };
}

export function blankStorageRow(key: string): StorageRow {
  return { key, id: null, unit_number: '', notes: null };
}

/** Stable serialisation for a dirty check — the client-only `key` is excluded. */
export function rowsSnapshot(parking: ParkingRow[], storage: StorageRow[]): string {
  return JSON.stringify({
    p: parking.map((r) => [r.id, r.lot_code, r.spot_number.trim(), r.size_type]),
    s: storage.map((r) => [r.id, r.unit_number.trim()]),
  });
}

// ── occupancy ────────────────────────────────────────────────────────────────

/** Who currently holds a number, for the pre-save occupancy check. */
export interface Occupant {
  id: string;
  number: string;
  apartment_number: string | null;
  owner_type: string;
}

export interface AssetIndex {
  spots: ParkingSpot[];
  units: StorageUnit[];
  parkingOccupancy: Map<string, Occupant>;
  storageOccupancy: Map<string, Occupant>;
}

/**
 * Load the live allocation of the lot plus every storage unit, and index both
 * by number.
 *
 * ACTIVE ROWS ONLY, both tables: "who holds this number" is a question about
 * the live allocation. Nothing in the UI deactivates any more, so an inactive
 * row can only come from outside it; should one exist, the server's own check —
 * which mirrors the unconditional unique index on (lot_code, spot_number) —
 * still refuses and names the holder. The client is not the layer that guards
 * the index.
 */
export async function fetchAssetIndex(): Promise<AssetIndex> {
  const [pRes, sRes] = await Promise.all([
    fetch(`/api/parking?lot_code=${encodeURIComponent(DEFAULT_LOT_CODE)}`, { credentials: 'include' }),
    fetch('/api/storage', { credentials: 'include' }),
  ]);
  if (!pRes.ok || !sRes.ok) throw new Error('טעינת החניות והמחסנים נכשלה');

  const [pData, sData] = await Promise.all([
    pRes.json() as Promise<{ spots?: ParkingSpot[] }>,
    sRes.json() as Promise<{ units?: StorageUnit[] }>,
  ]);
  const spots = Array.isArray(pData.spots) ? pData.spots : [];
  const units = Array.isArray(sData.units) ? sData.units : [];

  return {
    spots,
    units,
    parkingOccupancy: parkingOccupancyOf(spots),
    storageOccupancy: storageOccupancyOf(units),
  };
}

/** Index spots by their number. The /parking table holds the same rows in its
 *  own state and rebuilds the index from there, so both surfaces answer "who
 *  holds this number" from one implementation. */
export function parkingOccupancyOf(spots: ParkingSpot[]): Map<string, Occupant> {
  return new Map(spots.map((s) => [String(s.spot_number), {
    id: s.id, number: String(s.spot_number),
    apartment_number: s.apartment_number, owner_type: s.owner_type,
  }]));
}

export function storageOccupancyOf(units: StorageUnit[]): Map<string, Occupant> {
  return new Map(units.map((u) => [u.unit_number, {
    id: u.id, number: u.unit_number,
    apartment_number: u.apartment_number, owner_type: u.owner_type,
  }]));
}

// ── validation (mirrors lib/validation/parking.ts, plus occupancy) ───────────

/**
 * Is the number itself usable — shape, range, and not typed twice in the same
 * edit. `siblings` are the other rows being edited together; a number repeated
 * inside one edit is a clash the server would never see, because only one of
 * the two ever reaches it.
 *
 * Deliberately says nothing about who holds the number: the two surfaces answer
 * that differently. The tenant form refuses (it sees one apartment and cannot
 * transfer); the /parking table asks (it sees both sides of the move).
 */
export function parkingNumberError(row: ParkingRow, siblings: ParkingRow[]): string | null {
  const raw = row.spot_number.trim();
  if (!raw) return parkingErrorMessage('spot_number_required');
  const n = Number(raw);
  if (!Number.isInteger(n)) return parkingErrorMessage('spot_number_invalid');
  if (n < SPOT_NUMBER_MIN || n > SPOT_NUMBER_MAX) {
    return parkingErrorMessage('spot_number_out_of_range');
  }
  if (siblings.some((o) => o.key !== row.key && Number(o.spot_number.trim()) === n)) {
    return 'מספר החניה מופיע פעמיים';
  }
  return null;
}

export function storageNumberError(row: StorageRow, siblings: StorageRow[]): string | null {
  const raw = row.unit_number.trim();
  if (!raw) return parkingErrorMessage('unit_number_required');
  if (raw.length > STORAGE_UNIT_NUMBER_MAX) return parkingErrorMessage('unit_number_too_long');
  if (siblings.some((o) => o.key !== row.key && o.unit_number.trim() === raw)) {
    return 'מספר המחסן מופיע פעמיים';
  }
  return null;
}

/** The tenant form's rule: an occupied number is a refusal that names the
 *  holder and points at the page which can move it. */
export function parkingRowError(
  row: ParkingRow, siblings: ParkingRow[], occupancy: Map<string, Occupant>,
): string | null {
  const err = parkingNumberError(row, siblings);
  if (err) return err;
  const holder = occupancy.get(String(Number(row.spot_number.trim())));
  if (holder && holder.id !== row.id) return parkingTransferMessage('parking', holder);
  return null;
}

export function storageRowError(
  row: StorageRow, siblings: StorageRow[], occupancy: Map<string, Occupant>,
): string | null {
  const err = storageNumberError(row, siblings);
  if (err) return err;
  const holder = occupancy.get(row.unit_number.trim());
  if (holder && holder.id !== row.id) return parkingTransferMessage('storage', holder);
  return null;
}

// ── writes ───────────────────────────────────────────────────────────────────

interface ApiFailure {
  error?: string;
  code?: string;
}

/** POST/PATCH one asset. Throws with the server's Hebrew sentence, which for a
 *  409 already names the holder — so the row can show it verbatim. */
async function write<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & ApiFailure;
  if (!res.ok) throw new Error(data.error ?? 'שמירת השיוך נכשלה');
  return data;
}

/**
 * Create or update one spot. There is no separate "release" call: releasing is
 * this, with `owner` = RELEASED_OWNER, which is exactly what it means.
 */
export async function saveParkingRow(row: ParkingRow, owner: AssetOwner): Promise<ParkingSpot> {
  const body = {
    lot_code: row.lot_code,
    spot_number: Number(row.spot_number.trim()),
    size_type: row.size_type,
    owner_type: owner.owner_type,
    apartment_number: owner.apartment_number,
    sale_status: row.sale_status,
    notes: row.notes,
  };
  const { spot } = row.id === null
    ? await write<{ spot: ParkingSpot }>('/api/parking', 'POST', body)
    : await write<{ spot: ParkingSpot }>(`/api/parking/${row.id}`, 'PATCH', body);
  return spot;
}

export async function saveStorageRow(row: StorageRow, owner: AssetOwner): Promise<StorageUnit> {
  const body = {
    unit_number: row.unit_number.trim(),
    owner_type: owner.owner_type,
    apartment_number: owner.apartment_number,
    notes: row.notes,
  };
  const { unit } = row.id === null
    ? await write<{ unit: StorageUnit }>('/api/storage', 'POST', body)
    : await write<{ unit: StorageUnit }>(`/api/storage/${row.id}`, 'PATCH', body);
  return unit;
}

/** True when a saved row differs from the version last agreed with the server.
 *  A row that has not moved needs no PATCH. */
export function rowChanged<T extends ParkingRow | StorageRow>(baseline: T | undefined, row: T): boolean {
  return JSON.stringify(baseline) !== JSON.stringify(row);
}

import 'server-only';
import { query, queryOne } from '@/lib/db';
import type {
  ApartmentAssets,
  ParkingSpot,
  ParkingSpotFilters,
  ParkingSpotWritableFields,
  StorageUnit,
  StorageUnitFilters,
  StorageUnitWritableFields,
} from '@/lib/types/parking';
import { parkingConflictMessage } from '@/lib/parking/conflictMessage';

// Closed product rules enforced here rather than in the routes:
//   • NO DELETE, ever — the only removal path is toggleActive() with a reason.
//   • A double spot is one row; `capacity` is DB-generated and never written.
//   • Assigning a number that is already taken raises ParkingConflictError
//     carrying WHO holds it, so the user gets "כבר מוצמדת לדירה 1234" rather
//     than a bare 409.

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * A spot/unit number is already taken. Carries the current holder so the route
 * can name them: the whole value of this error over a raw unique violation is
 * that the user learns WHERE the number went.
 */
export class ParkingConflictError extends Error {
  readonly kind: 'parking' | 'storage';
  readonly number: string;
  readonly holderApartment: string | null;
  readonly holderOwnerType: string;
  readonly holderId: string;

  constructor(args: {
    kind: 'parking' | 'storage';
    number: string;
    holderApartment: string | null;
    holderOwnerType: string;
    holderId: string;
  }) {
    // Phrased by the shared helper so the client's pre-save occupancy check
    // renders the identical sentence (lib/parking/conflictMessage.ts).
    super(parkingConflictMessage(args.kind, {
      number: args.number,
      apartment_number: args.holderApartment,
      owner_type: args.holderOwnerType,
    }));
    this.name = 'ParkingConflictError';
    this.kind = args.kind;
    this.number = args.number;
    this.holderApartment = args.holderApartment;
    this.holderOwnerType = args.holderOwnerType;
    this.holderId = args.holderId;
  }
}

/** apartment_number has no contacts row. There is no FK (see migration 076), so
 *  this is checked explicitly on every write that names an apartment. */
export class ApartmentNotFoundError extends Error {
  readonly apartmentNumber: string;
  constructor(apartmentNumber: string) {
    super(`מספר הדירה ${apartmentNumber} אינו קיים ברשימת הדיירים`);
    this.name = 'ApartmentNotFoundError';
    this.apartmentNumber = apartmentNumber;
  }
}

// ── column lists ─────────────────────────────────────────────────────────────

const PARKING_COLUMNS = `
  id, lot_code, spot_number, size_type, capacity, owner_type, apartment_number,
  sale_status, notes, is_active, deactivated_at, deactivated_by,
  deactivation_reason, created_at, updated_at, created_by, updated_by`;

const STORAGE_COLUMNS = `
  id, unit_number, owner_type, apartment_number, notes, is_active,
  deactivated_at, deactivated_by, deactivation_reason,
  created_at, updated_at, created_by, updated_by`;

// ── shared guards ────────────────────────────────────────────────────────────

/** True when a contacts row carries this apartment_number. */
export async function apartmentExists(apartmentNumber: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `select exists(select 1 from public.contacts where apartment_number = $1) as exists`,
    [apartmentNumber],
  );
  return row?.exists === true;
}

async function assertApartmentExists(apartmentNumber: string | null): Promise<void> {
  if (apartmentNumber === null) return;
  if (!(await apartmentExists(apartmentNumber))) {
    throw new ApartmentNotFoundError(apartmentNumber);
  }
}

/**
 * Parking numbers are unique per lot REGARDLESS of is_active — a painted number
 * on a physical floor does not free up when the spot is unassigned. `excludeId`
 * lets an update keep its own number.
 */
async function assertSpotNumberFree(
  lotCode: string,
  spotNumber: number,
  excludeId: string | null,
): Promise<void> {
  const holder = await queryOne<{
    id: string; apartment_number: string | null; owner_type: string;
  }>(
    `select id, apartment_number, owner_type
       from public.parking_spots
      where lot_code = $1 and spot_number = $2 and ($3::uuid is null or id <> $3)
      limit 1`,
    [lotCode, spotNumber, excludeId],
  );
  if (holder) {
    throw new ParkingConflictError({
      kind: 'parking',
      number: String(spotNumber),
      holderApartment: holder.apartment_number,
      holderOwnerType: holder.owner_type,
      holderId: holder.id,
    });
  }
}

/**
 * Storage numbers collide only among ACTIVE units — a released number is
 * genuinely re-issuable (partial unique index storage_units_number_active_uniq).
 */
async function assertUnitNumberFree(
  unitNumber: string,
  excludeId: string | null,
): Promise<void> {
  const holder = await queryOne<{
    id: string; apartment_number: string | null; owner_type: string;
  }>(
    `select id, apartment_number, owner_type
       from public.storage_units
      where unit_number = $1 and is_active and ($2::uuid is null or id <> $2)
      limit 1`,
    [unitNumber, excludeId],
  );
  if (holder) {
    throw new ParkingConflictError({
      kind: 'storage',
      number: unitNumber,
      holderApartment: holder.apartment_number,
      holderOwnerType: holder.owner_type,
      holderId: holder.id,
    });
  }
}

// ── parking_spots: read ──────────────────────────────────────────────────────

export async function listParkingSpots(f: ParkingSpotFilters = {}): Promise<ParkingSpot[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!f.includeInactive) where.push('is_active');

  if (f.lot_code) {
    params.push(f.lot_code);
    where.push(`lot_code = $${params.length}`);
  }
  if (f.owner_type) {
    params.push(f.owner_type);
    where.push(`owner_type = $${params.length}`);
  }
  if (f.apartment_number) {
    params.push(f.apartment_number);
    where.push(`apartment_number = $${params.length}`);
  }
  if (f.size_type) {
    params.push(f.size_type);
    where.push(`size_type = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    // spot_number is an integer — cast so a free-text "63" still matches it.
    where.push(`(spot_number::text ilike ${p} or apartment_number ilike ${p} or notes ilike ${p})`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<ParkingSpot>(
    `select ${PARKING_COLUMNS} from public.parking_spots
      ${whereSql} order by lot_code asc, spot_number asc`,
    params,
  );
  return r.rows;
}

export async function getParkingSpotById(id: string): Promise<ParkingSpot | null> {
  return queryOne<ParkingSpot>(
    `select ${PARKING_COLUMNS} from public.parking_spots where id = $1`,
    [id],
  );
}

// ── parking_spots: write ─────────────────────────────────────────────────────

export async function createParkingSpot(
  fields: ParkingSpotWritableFields,
  actorId: string,
): Promise<ParkingSpot> {
  await assertApartmentExists(fields.apartment_number);
  await assertSpotNumberFree(fields.lot_code, fields.spot_number, null);

  const row = await queryOne<ParkingSpot>(
    `insert into public.parking_spots
       (lot_code, spot_number, size_type, owner_type, apartment_number,
        sale_status, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     returning ${PARKING_COLUMNS}`,
    [
      fields.lot_code, fields.spot_number, fields.size_type, fields.owner_type,
      fields.apartment_number, fields.sale_status, fields.notes, actorId,
    ],
  );
  if (!row) throw new Error('failed_to_create_parking_spot');
  return row;
}

/** Whole-object update (the panel saves the full spot in one PATCH). */
export async function updateParkingSpot(
  id: string,
  fields: ParkingSpotWritableFields,
  actorId: string,
): Promise<ParkingSpot | null> {
  const existing = await getParkingSpotById(id);
  if (!existing) return null;

  await assertApartmentExists(fields.apartment_number);
  await assertSpotNumberFree(fields.lot_code, fields.spot_number, id);

  return queryOne<ParkingSpot>(
    `update public.parking_spots
        set lot_code = $2, spot_number = $3, size_type = $4, owner_type = $5,
            apartment_number = $6, sale_status = $7, notes = $8, updated_by = $9
      where id = $1
      returning ${PARKING_COLUMNS}`,
    [
      id, fields.lot_code, fields.spot_number, fields.size_type, fields.owner_type,
      fields.apartment_number, fields.sale_status, fields.notes, actorId,
    ],
  );
}

/**
 * The ONLY removal path — there is no delete. Reactivating CLEARS the
 * deactivation columns rather than keeping them as history: the three columns
 * describe one fact ("currently off, since T, by U, because R"), and letting
 * them linger on an active row would render as "this spot is deactivated" in
 * every panel that reads them. Per-event history would need a parking_events
 * table (the chips module has one); this module does not have that yet.
 */
export async function toggleParkingSpotActive(
  id: string,
  isActive: boolean,
  reason: string | null,
  actorId: string,
): Promise<ParkingSpot | null> {
  if (isActive) {
    return queryOne<ParkingSpot>(
      `update public.parking_spots
          set is_active = true, deactivated_at = null, deactivated_by = null,
              deactivation_reason = null, updated_by = $2
        where id = $1
        returning ${PARKING_COLUMNS}`,
      [id, actorId],
    );
  }
  return queryOne<ParkingSpot>(
    `update public.parking_spots
        set is_active = false, deactivated_at = now(), deactivated_by = $2,
            deactivation_reason = $3, updated_by = $2
      where id = $1
      returning ${PARKING_COLUMNS}`,
    [id, actorId, reason],
  );
}

// ── storage_units: read ──────────────────────────────────────────────────────

export async function listStorageUnits(f: StorageUnitFilters = {}): Promise<StorageUnit[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!f.includeInactive) where.push('is_active');

  if (f.owner_type) {
    params.push(f.owner_type);
    where.push(`owner_type = $${params.length}`);
  }
  if (f.apartment_number) {
    params.push(f.apartment_number);
    where.push(`apartment_number = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(`(unit_number ilike ${p} or apartment_number ilike ${p} or notes ilike ${p})`);
  }

  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const r = await query<StorageUnit>(
    `select ${STORAGE_COLUMNS} from public.storage_units
      ${whereSql} order by unit_number asc`,
    params,
  );
  return r.rows;
}

export async function getStorageUnitById(id: string): Promise<StorageUnit | null> {
  return queryOne<StorageUnit>(
    `select ${STORAGE_COLUMNS} from public.storage_units where id = $1`,
    [id],
  );
}

// ── storage_units: write ─────────────────────────────────────────────────────

export async function createStorageUnit(
  fields: StorageUnitWritableFields,
  actorId: string,
): Promise<StorageUnit> {
  await assertApartmentExists(fields.apartment_number);
  await assertUnitNumberFree(fields.unit_number, null);

  const row = await queryOne<StorageUnit>(
    `insert into public.storage_units
       (unit_number, owner_type, apartment_number, notes, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5)
     returning ${STORAGE_COLUMNS}`,
    [fields.unit_number, fields.owner_type, fields.apartment_number, fields.notes, actorId],
  );
  if (!row) throw new Error('failed_to_create_storage_unit');
  return row;
}

export async function updateStorageUnit(
  id: string,
  fields: StorageUnitWritableFields,
  actorId: string,
): Promise<StorageUnit | null> {
  const existing = await getStorageUnitById(id);
  if (!existing) return null;

  await assertApartmentExists(fields.apartment_number);
  await assertUnitNumberFree(fields.unit_number, id);

  return queryOne<StorageUnit>(
    `update public.storage_units
        set unit_number = $2, owner_type = $3, apartment_number = $4,
            notes = $5, updated_by = $6
      where id = $1
      returning ${STORAGE_COLUMNS}`,
    [id, fields.unit_number, fields.owner_type, fields.apartment_number, fields.notes, actorId],
  );
}

/**
 * Same contract as toggleParkingSpotActive. Reactivating can fail on the
 * partial unique index if the number was re-issued in the meantime — that
 * surfaces as a 23505 and is mapped to a conflict by the route.
 */
export async function toggleStorageUnitActive(
  id: string,
  isActive: boolean,
  reason: string | null,
  actorId: string,
): Promise<StorageUnit | null> {
  if (isActive) {
    const unit = await getStorageUnitById(id);
    if (!unit) return null;
    // Pre-check so re-activating a number someone else took reports WHO took it.
    await assertUnitNumberFree(unit.unit_number, id);
    return queryOne<StorageUnit>(
      `update public.storage_units
          set is_active = true, deactivated_at = null, deactivated_by = null,
              deactivation_reason = null, updated_by = $2
        where id = $1
        returning ${STORAGE_COLUMNS}`,
      [id, actorId],
    );
  }
  return queryOne<StorageUnit>(
    `update public.storage_units
        set is_active = false, deactivated_at = now(), deactivated_by = $2,
            deactivation_reason = $3, updated_by = $2
      where id = $1
      returning ${STORAGE_COLUMNS}`,
    [id, actorId, reason],
  );
}

// ── by apartment ─────────────────────────────────────────────────────────────

/** Everything one apartment holds — both tables in one round trip each. */
export async function getApartmentAssets(apartmentNumber: string): Promise<ApartmentAssets> {
  const [exists, parking, storage] = await Promise.all([
    apartmentExists(apartmentNumber),
    listParkingSpots({ apartment_number: apartmentNumber }),
    listStorageUnits({ apartment_number: apartmentNumber }),
  ]);
  return {
    apartment_number: apartmentNumber,
    apartment_exists: exists,
    parking,
    storage,
    total_places: parking.reduce((sum, p) => sum + p.capacity, 0),
  };
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { createStorageUnit, listStorageUnits } from '@/lib/db/parking';
import { parkingBadRequest, parkingErrorResponse } from '@/lib/parking/apiErrors';
import { coerceAndValidateStorageUnit } from '@/lib/validation/parking';
import { PARKING_OWNER_TYPES } from '@/lib/constants/parking';
import type { ParkingOwnerType, StorageUnitFilters } from '@/lib/types/parking';

export const runtime = 'nodejs';

// Storage units share the 'parking' permission module with parking spots — one
// screen, one operational concern (see lib/permissions/constants.ts). There is
// no separate 'storage' module to grant.

// GET /api/storage?owner_type&apartment_number&q&include_inactive (parking:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('parking', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const ownerRaw = sp.get('owner_type')?.trim();

  const filters: StorageUnitFilters = {
    owner_type: ownerRaw && PARKING_OWNER_TYPES.includes(ownerRaw as ParkingOwnerType)
      ? (ownerRaw as ParkingOwnerType) : undefined,
    apartment_number: sp.get('apartment_number')?.trim() || undefined,
    q: sp.get('q')?.trim() || undefined,
    includeInactive: sp.get('include_inactive') === '1',
  };

  const units = await listStorageUnits(filters);
  return NextResponse.json({ units });
}

// POST /api/storage (parking:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('parking', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return parkingBadRequest('invalid_json');
  }

  const result = coerceAndValidateStorageUnit((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const unit = await createStorageUnit(result.fields, actor.id);
    return NextResponse.json({ unit }, { status: 201 });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    console.error('[POST /api/storage]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

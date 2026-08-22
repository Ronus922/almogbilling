import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { createParkingSpot, listParkingSpots } from '@/lib/db/parking';
import { parkingBadRequest, parkingErrorResponse } from '@/lib/parking/apiErrors';
import { coerceAndValidateParkingSpot } from '@/lib/validation/parking';
import {
  PARKING_OWNER_TYPES, PARKING_SIZE_TYPES,
} from '@/lib/constants/parking';
import type {
  ParkingOwnerType, ParkingSizeType, ParkingSpotFilters,
} from '@/lib/types/parking';

export const runtime = 'nodejs';

// GET /api/parking?owner_type&apartment_number&size_type&q&include_inactive
// (parking:view — there is no open read here; the allocation of the lot is not
// public inside the app either.)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('parking', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  // An unknown filter value is ignored rather than 400'd: these arrive from
  // shareable URLs, and a stale link should degrade to "unfiltered", not error.
  const ownerRaw = sp.get('owner_type')?.trim();
  const sizeRaw = sp.get('size_type')?.trim();

  const filters: ParkingSpotFilters = {
    owner_type: ownerRaw && PARKING_OWNER_TYPES.includes(ownerRaw as ParkingOwnerType)
      ? (ownerRaw as ParkingOwnerType) : undefined,
    size_type: sizeRaw && PARKING_SIZE_TYPES.includes(sizeRaw as ParkingSizeType)
      ? (sizeRaw as ParkingSizeType) : undefined,
    apartment_number: sp.get('apartment_number')?.trim() || undefined,
    q: sp.get('q')?.trim() || undefined,
    includeInactive: sp.get('include_inactive') === '1',
  };

  const spots = await listParkingSpots(filters);
  return NextResponse.json({ spots });
}

// POST /api/parking (parking:edit)
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

  const result = coerceAndValidateParkingSpot((body ?? {}) as Record<string, unknown>);
  if (!result.ok) return parkingBadRequest(result.code);

  try {
    const spot = await createParkingSpot(result.fields, actor.id);
    return NextResponse.json({ spot }, { status: 201 });
  } catch (err) {
    const mapped = parkingErrorResponse(err);
    if (mapped) return mapped;
    console.error('[POST /api/parking]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

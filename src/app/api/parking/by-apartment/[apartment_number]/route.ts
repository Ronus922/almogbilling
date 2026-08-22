import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getApartmentAssets } from '@/lib/db/parking';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ apartment_number: string }>;
}

// GET /api/parking/by-apartment/[apartment_number] (parking:view)
//
// Returns BOTH tables for one apartment — it answers a single question ("what
// does this apartment hold?") that would otherwise need two round trips from
// the contacts panel, so there is no mirror of this under /api/storage.
//
// An apartment with nothing, and an apartment that does not exist, are
// different answers: both return 200 with empty lists, but `apartment_exists`
// separates them so the caller can say "לא נמצאה דירה" instead of "אין חניות".
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('parking', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { apartment_number } = await ctx.params;
  const apartmentNumber = decodeURIComponent(apartment_number).trim();
  if (!apartmentNumber) {
    return NextResponse.json(
      { error: 'יש להזין מספר דירה', code: 'apartment_number_required' },
      { status: 400 },
    );
  }

  const assets = await getApartmentAssets(apartmentNumber);
  return NextResponse.json(assets);
}

import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listPortalEvents } from '@/lib/db/portal/events';
import { activeLockoutsForApartment } from '@/lib/db/portal/lockouts';

export const runtime = 'nodejs';

// GET /api/apartments/[apartment]/portal-log — the login log of ONE apartment,
// plus whichever of its phones are locked out right now (the card's banner).
// `portal_manage:view` (admin / super_admin).
//
// The filter is `apartment = any(apartment_numbers)`, so an attempt from a phone
// that owns several apartments shows up on each of their cards — which is what an
// admin looking at one apartment expects to see.
export async function GET(_req: Request, { params }: { params: Promise<{ apartment: string }> }) {
  try {
    await requirePermission('portal_manage', 'view');
    const { apartment } = await params;
    const [events, lockouts] = await Promise.all([
      listPortalEvents({ apartment }),
      activeLockoutsForApartment(apartment),
    ]);
    return NextResponse.json({ events, lockouts });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

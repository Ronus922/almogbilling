import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { requirePortalSession } from '@/lib/portal/session';
import { getPublishedMonths } from '@/lib/db/finance/portal';
import { publishedMonthKeys } from '@/lib/finance/resident';

export const runtime = 'nodejs';

// GET /api/portal/finance/months — the months a resident may open ('YYYY-MM',
// newest first). Read-only, and guarded by requirePortalSession — NOT by
// requireAdmin: a resident holds no users row and no permission matrix.
//
// The published filter is not applied here at all: getPublishedMonths only ever
// returns published rows (the predicate is in its SQL, see portal.ts).
export async function GET() {
  try {
    await requirePortalSession();
    const months = publishedMonthKeys(await getPublishedMonths());
    return NextResponse.json({ months });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

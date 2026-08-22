import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getParkingSummary } from '@/lib/db/parking';

export const runtime = 'nodejs';

// GET /api/parking/summary (parking:view)
//
// The six document rows + the total, each carrying `actual`, `expected` and
// `ok`, plus the contacts-integrity check and the KPI block. `expected` comes
// from lib/constants/parking.ts — transcribed from the 2015 document and never
// derived from the rows being checked.
//
// Static segment, so it is matched before /api/parking/[id] and no UUID is
// ever routed here.
export async function GET() {
  try {
    await requirePermission('parking', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  try {
    const summary = await getParkingSummary();
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[GET /api/parking/summary]', err);
    return NextResponse.json({ error: 'שגיאת שרת', code: 'server_error' }, { status: 500 });
  }
}

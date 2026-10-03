import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listBlockedPortalPhones } from '@/lib/db/portal/ownerPhones';

export const runtime = 'nodejs';

// GET /api/admin/portal-blocked — every phone the containment blocks right now
// (its active apartments belong to different people, lib/portal/ownership.ts),
// with each link behind it. Read-only: a link is detached on the apartment's
// own endpoint (/api/apartments/[apartment]/owner-phones), and a name is unified
// on the apartment card. `portal_manage:view` (admin / super_admin).
export async function GET() {
  try {
    await requirePermission('portal_manage', 'view');
    return NextResponse.json({ phones: await listBlockedPortalPhones() });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

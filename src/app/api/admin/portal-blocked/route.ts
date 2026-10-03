import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listApprovedIdentities, listBlockedPortalPhones } from '@/lib/db/portal/blockedPhones';

export const runtime = 'nodejs';

// GET /api/admin/portal-blocked — every phone the portal blocks right now
// (lib/portal/identity.ts), with each link behind it, the classifier's
// suggestion and any waiting "same person" request; and the identities in
// force. Read-only: "אדם אחד" / revoke go through /api/admin/portal-identity,
// a link is detached on the apartment's own endpoint
// (/api/apartments/[apartment]/owner-phones), and a name is completed on the
// apartment card. `portal_manage:view` (admin / super_admin).
export async function GET() {
  try {
    await requirePermission('portal_manage', 'view');
    const [phones, approved] = await Promise.all([listBlockedPortalPhones(), listApprovedIdentities()]);
    return NextResponse.json({ phones, approved });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

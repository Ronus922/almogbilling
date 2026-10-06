import { NextResponse } from 'next/server';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { requirePortalFinanceAccess } from '@/lib/portal/session';
import { listPublishedDecisions } from '@/lib/db/portalDecisions';
import { toDecisionPortalView } from '@/lib/decisionsView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/portal/decisions — the decisions and protocols an owner may read:
// published only, newest decision first.
//
// Guarded by requirePortalFinanceAccess, exactly like the portal's financial
// endpoints — a live portal session AND not a blocked phone (the portal's one
// identity, lib/portal/identity.ts) — NOT by requireAdmin: a resident holds no
// users row and no permission matrix.
//
// The published filter is not applied here at all: listPublishedDecisions only
// ever returns published rows (the predicate is in its SQL), and
// toDecisionPortalView drops the object key, the bucket and the uploader, so
// nothing a resident receives points at Storage.
export async function GET() {
  try {
    await requirePortalFinanceAccess();
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  const rows = await listPublishedDecisions();
  return NextResponse.json({ decisions: rows.map(toDecisionPortalView) });
}

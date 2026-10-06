import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { requirePortalFinanceAccess } from '@/lib/portal/session';
import { getResidentCategoryTrend } from '@/lib/db/finance/portal';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/portal/finance/categories/[id]/monthly — the trend a category row of
// the transactions tab opens on: `{ months: [{ month: 'YYYY-MM', total }] }`,
// oldest first, up to 12 — the newest PUBLISHED months, whatever period the
// tab's picker is on. `total` is the category's sum in whole shekels (exact sum,
// rounded once); a published month without a line is 0. A monthly sum and
// nothing else — no line, no supplier, no description.
//
// Guarded exactly like the portal's other financial endpoints:
// requirePortalFinanceAccess (a live portal session whose phone is not a
// blocked phone) — 401 / 403 before the id is even looked at. The published
// rule is not applied here: getResidentCategoryTrend builds its window from
// published rows in the SQL, so an unpublished month cannot reach this answer.
//
// The id is not trusted: anything that is not a UUID, an unknown id and a
// category that is not on that tab (a renovation-fund one) are all the same
// 404.
export async function GET(_req: Request, ctx: RouteCtx) {
  try {
    await requirePortalFinanceAccess();
    const { id } = await ctx.params;
    const months = z.uuid().safeParse(id).success ? await getResidentCategoryTrend(id) : null;
    if (!months) return NextResponse.json({ error: 'הסעיף לא נמצא' }, { status: 404 });
    return NextResponse.json({ months });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

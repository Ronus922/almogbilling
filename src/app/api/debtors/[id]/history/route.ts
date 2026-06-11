import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listDebtorHistory,
  HISTORY_LIMIT_DEFAULT,
} from '@/lib/db/debtorHistory';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/debtors/[id]/history — unified timeline (comments + status changes +
// completed actions + events), newest first. Read access = contacts:view.
export async function GET(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('contacts', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const rawLimit = req.nextUrl.searchParams.get('limit');
  const limit = rawLimit ? Number(rawLimit) : HISTORY_LIMIT_DEFAULT;

  const entries = await listDebtorHistory(
    id,
    Number.isFinite(limit) ? limit : HISTORY_LIMIT_DEFAULT,
  );
  return NextResponse.json(entries);
}

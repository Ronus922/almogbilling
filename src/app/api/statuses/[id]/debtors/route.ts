import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listDebtorsByStatus } from '@/lib/db/statuses';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/statuses/[id]/debtors — non-archived debtors linked to status.
// Capped to 500 rows by the DB helper (matches the linked-count UX).
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('status_management', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const rows = await listDebtorsByStatus(id);
  return NextResponse.json(rows);
}

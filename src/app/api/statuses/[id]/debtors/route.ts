import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDebtorsByStatus } from '@/lib/db/statuses';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/statuses/[id]/debtors — non-archived debtors linked to status.
// Capped to 500 rows by the DB helper (matches the linked-count UX).
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const rows = await listDebtorsByStatus(id);
  return NextResponse.json(rows);
}

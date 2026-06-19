import { NextResponse, type NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listCompletedActionsByDebtor } from '@/lib/db/completedActions';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    // Debtors screen read — granted by `dashboard` (viewer) OR `contacts` (manager).
    await requireAnyPermission([
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const rows = await listCompletedActionsByDebtor(id);
  return NextResponse.json(rows);
}

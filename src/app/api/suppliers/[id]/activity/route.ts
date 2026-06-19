import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listSupplierActivity } from '@/lib/db/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/suppliers/[id]/activity (suppliers:view) — the automatic activity
// log (central audit_log, entity_type='supplier'), newest first.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const activity = await listSupplierActivity(id);
  return NextResponse.json({ activity });
}

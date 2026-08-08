import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listChipEvents } from '@/lib/db/chips';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/chips/[id]/events (chips:view) — the chip's append-only audit trail.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('chips', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const items = await listChipEvents(id);
  return NextResponse.json({ items });
}

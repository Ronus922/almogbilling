import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipOrderWindow } from '@/lib/db/chipOrderWindow';
import { badOrderId } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders/items/[itemId] (chips_orders_manage:view) — what the
// issue window needs when an Orders-tab row opens it (20/11/2026 design): the
// whole order — its transaction details, its apartment lines with their price
// snapshot, one block per person (holder lines; one per apartment for an order
// made before 20/11/2026) with the chips issued for them and the same person's
// earlier chips (matched by phone). Grow tokens are never part of it.
export async function GET(_req: Request, ctx: { params: Promise<{ itemId: string }> }) {
  try {
    await requirePermission('chips_orders_manage', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { itemId } = await ctx.params;
  const bad = badOrderId(itemId);
  if (bad) return bad;
  const window = await getChipOrderWindow(itemId);
  if (!window) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ window });
}

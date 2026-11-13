import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getChipOrderSheetContext } from '@/lib/db/chipOrders';
import { badOrderId } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders/items/[itemId] (chips_orders_manage:view) — what the
// issue window needs when an Orders-tab row opens it (13/11/2026): the
// apartment, the row's orderer (the holder block is matched by that phone, or
// prefilled from it), and one "פרטי הזמנה" section for every OPEN order of the
// same person for this apartment. Grow tokens are never part of it.
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
  const context = await getChipOrderSheetContext(itemId);
  if (!context) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ context });
}

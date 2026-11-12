import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countUnfinishedTestOrders, listChipOrders } from '@/lib/db/chipOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders (chips_orders_manage:view) — every PAID order, newest
// first within its status group. pending_payment never appears. Test orders
// carry is_test; `unfinishedTestOrders` counts the test orders never finished
// (pending_payment), which only "מחק את כל הזמנות הבדיקה" removes.
export async function GET() {
  try {
    await requirePermission('chips_orders_manage', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const [items, unfinishedTestOrders] = await Promise.all([listChipOrders(), countUnfinishedTestOrders()]);
  return NextResponse.json({ items, unfinishedTestOrders });
}

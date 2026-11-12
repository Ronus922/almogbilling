import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listChipOrders } from '@/lib/db/chipOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/chip-orders (chips_orders_manage:view) — every PAID order, newest
// first within its status group. pending_payment never appears.
export async function GET() {
  try {
    await requirePermission('chips_orders_manage', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return NextResponse.json({ items: await listChipOrders() });
}

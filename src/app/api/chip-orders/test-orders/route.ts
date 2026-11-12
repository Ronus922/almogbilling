import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { writeAudit } from '@/lib/db/audit';
import { deleteAllTestChipOrders } from '@/lib/chipOrders/cleanup';

export const runtime = 'nodejs';

// DELETE /api/chip-orders/test-orders (chips_orders_manage:edit) — "מחק את כל
// הזמנות הבדיקה": every TEST order, in any status (also the ones never
// finished, which /chips does not list), with its lines, messages and lease
// files — files first. A real order is never touched (the delete is locked to
// is_test). Chips issued for a test order stay in the chips module; their
// order_item_id becomes NULL.
export async function DELETE() {
  let actor: Actor;
  try {
    actor = await requirePermission('chips_orders_manage', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const result = await deleteAllTestChipOrders();
  await writeAudit({ actorUserId: actor.id, action: 'test_orders_deleted', entityType: 'chip_order', metadata: result });
  return NextResponse.json({ ok: result.fileFailed === 0, ...result });
}

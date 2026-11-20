import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { writeAudit } from '@/lib/db/audit';
import { deleteTestChipOrder } from '@/lib/chipOrders/cleanup';
import { listActiveChipIdsOfTestOrder } from '@/lib/db/chipOrderWindow';
import { deactivateChip } from '@/lib/db/chips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/chip-orders/[id] (chips_orders_manage:edit) — "מחק הזמנת בדיקה".
// TEST orders only (the button sits in the order's "פרטי הזמנה" section of
// the issue window): the delete is locked to is_test, so a real order answers
// 404 and is never touched. Lease files first, then the row; a chip issued
// for the order stays in the chips module (its order_item_id becomes NULL).
// From 20/11/2026 the order's ACTIVE chips are disabled first (reason
// 'unknown', a chip event each, like the toggle) — chips are never deleted.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips_orders_manage', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const who = { id: actor.id, name: actor.full_name ?? actor.username };
  for (const chipId of await listActiveChipIdsOfTestOrder(id)) {
    await deactivateChip(chipId, { reason: 'unknown' }, who);
  }
  const result = await deleteTestChipOrder(id);
  if (result.notFound) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (result.fileFailed) {
    return NextResponse.json({ error: 'קובץ החוזה לא נמחק — ההזמנה נשארה. נסו שוב.' }, { status: 502 });
  }
  await writeAudit({ actorUserId: actor.id, action: 'test_order_deleted', entityType: 'chip_order', entityId: id });
  return NextResponse.json({ ok: true });
}

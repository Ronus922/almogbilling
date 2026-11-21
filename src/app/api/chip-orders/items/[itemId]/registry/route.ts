import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderRegistryBodySchema } from '@/lib/validation/requests';
import { writeOrderHolderToRegistry } from '@/lib/db/chipOrders';
import { writeAudit } from '@/lib/db/audit';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';

// POST /api/chip-orders/items/[itemId]/registry — "עדכן בכרטיס הדייר"
// (13/11/2026, replaces the per-field checkboxes of the removed approval). It
// copies the holder block's name and phone into the tenants list of the
// line's apartment, in the slot of the block's role (the order's role when the
// body names none — 20/11/2026), and ONLY on this click.
// Writing to the tenants list is a contacts edit (and an owner phone opens the
// owners portal), so it needs contacts:edit — checked here, on the server —
// on top of handling the order (chips_orders_manage:edit).
export async function POST(req: Request, ctx: { params: Promise<{ itemId: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  if (!hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit')) {
    return NextResponse.json({ error: 'אין הרשאה לטפל בהזמנות צ׳יפים' }, { status: 403 });
  }
  const { itemId } = await ctx.params;
  const bad = badOrderId(itemId);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderRegistryBodySchema);
  if (!body.ok) return body.response;
  try {
    const res = await writeOrderHolderToRegistry(itemId, { name: body.data.name ?? null, phone: body.data.phone ?? null }, body.data.role);
    if (!res) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    after(() =>
      writeAudit({
        actorUserId: actor.id,
        action: 'updated',
        entityType: 'contact',
        entityId: res.contact_id,
        changes: { after: res.fields },
        metadata: { source: 'chip_order_registry_button', chip_order_id: res.order_id, apartment_number: res.apartment_number, role: res.role },
      }),
    );
    return NextResponse.json({ ok: true, role: res.role, fields: res.fields });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/items/:itemId/registry');
  }
}

import { NextResponse, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderApproveBodySchema } from '@/lib/validation/requests';
import { approveChipOrder } from '@/lib/db/chipOrders';
import { writeAudit } from '@/lib/db/audit';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';

// POST /api/chip-orders/[id]/approve (chips_orders_manage:edit) — "אשר":
// writes ONLY the ticked fields to the tenants list (owner / tenant / operator
// slot by the order's role), sets approved_at and due_at (72 working hours,
// Sunday–Thursday), audits what changed, then messages the orderer (email +
// WhatsApp) after the response.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips_orders_manage', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderApproveBodySchema);
  if (!body.ok) return body.response;
  // Writing to the tenants list is a contacts edit (and a phone there opens the
  // owners portal) — chips_orders_manage alone does not grant it.
  const writes = body.data.fields.some((f) => f.name || f.phone || f.email);
  if (writes && !hasPermission(actor.role, actor.permissions, 'contacts', 'edit')) {
    return NextResponse.json({ error: 'כתיבה לרשימת הדיירים דורשת הרשאת עריכה ברשימת הדיירים' }, { status: 403 });
  }
  try {
    const res = await approveChipOrder(id, body.data.fields);
    if (!res) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    after(async () => {
      await writeAudit({ actorUserId: actor.id, action: 'approved', entityType: 'chip_order', entityId: id });
      for (const w of res.written) {
        await writeAudit({
          actorUserId: actor.id,
          action: 'updated',
          entityType: 'contact',
          entityId: w.contact_id,
          changes: { after: w.fields },
          metadata: { source: 'chip_order_approval', chip_order_id: id, apartment_number: w.apartment_number },
        });
      }
      await notifyChipOrder(id, 'approved');
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/approve');
  }
}

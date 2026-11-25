import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { hasPermission } from '@/lib/permissions/check';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderWindowSaveSchema } from '@/lib/validation/requests';
import { saveChipOrderWindow, WindowChipConflictError, WindowInputError } from '@/lib/db/chipOrderWindow';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/holders — "שמור שינויים" of the order's issue
// window (20/11/2026): the holder blocks (edits, staff-added holders, new chip
// numbers linked to the order line and the holder line) and the internal note,
// in ONE transaction. Issuing chips is chips:edit; doing it for an order is
// also chips_orders_manage:edit — the same two guards the issue window had.
// No limit of active chips per apartment (21/11/2026). The window's fee fields
// ("עמלת הנפקה", "החיוב בוצע") were removed on 25/11/2026: a body that still
// carries them is accepted and they are ignored.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  if (!hasPermission(actor.role, actor.permissions, 'chips_orders_manage', 'edit')) {
    return NextResponse.json({ error: 'אין הרשאה לשייך צ׳יפים להזמנה' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderWindowSaveSchema);
  if (!body.ok) return body.response;
  try {
    const res = await saveChipOrderWindow(
      id,
      {
        holders: body.data.holders.map((h) => ({ ...h, email: h.email || null })),
        removedHolderIds: body.data.removed_holder_ids ?? [],
        note: body.data.note,
      },
      { id: actor.id, name: actor.full_name ?? actor.username },
    );
    if (!res) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...res }, { status: res.issued > 0 ? 201 : 200 });
  } catch (err) {
    if (err instanceof WindowChipConflictError) {
      return NextResponse.json(
        { error: `מספר צ׳יפ ${err.chipNumber} כבר פעיל במערכת`, chip_number: err.chipNumber, holder_index: err.holderIndex },
        { status: 409 },
      );
    }
    if (err instanceof WindowInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'invalid_chip_numbers') {
      return NextResponse.json({ error: 'מספרי צ׳יפ לא תקינים' }, { status: 400 });
    }
    if (err instanceof Error && err.message === 'order_not_open') {
      return NextResponse.json({ error: 'ההזמנה כבר נאספה או נדחתה — אי אפשר לשייך לה צ׳יפים' }, { status: 409 });
    }
    if (err instanceof Error && err.message === 'holder_not_in_registry') {
      return NextResponse.json({ error: 'לתפקיד זה אין פרטים במרשם הדירה — הזן שם או בחר "אורח"' }, { status: 422 });
    }
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/holders');
  }
}

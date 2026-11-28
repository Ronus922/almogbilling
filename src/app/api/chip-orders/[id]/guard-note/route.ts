import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderGuardNoteBodySchema } from '@/lib/validation/requests';
import { setChipOrderGuardNote } from '@/lib/db/chipOrderNotes';
import { mayWriteChipNote } from '@/lib/chipOrders/notes';
import { noteWriter } from '@/lib/chipOrders/noteWriter';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/guard-note — "הערה לשומר" on its own (27/11/2026):
// the reception window's line of a web order of the apartment. The order
// window saves the same note with its "שמור שינויים" (…/holders). Writers:
// chips:edit + chips_orders_manage:edit (mayWriteChipNote('guard')), never a
// guard. Only while the order is open (409 otherwise). Body: { guard_note }
// (null / empty clears it). Audited ('guard_note_set').
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('chips', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  if (!mayWriteChipNote('guard', noteWriter(actor))) {
    return NextResponse.json({ error: 'אין הרשאה לכתוב הערה לשומר' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderGuardNoteBodySchema);
  if (!body.ok) return body.response;
  // The note is named on purpose: `{}` never clears it (null or "" does).
  if (body.data.guard_note === undefined) {
    return NextResponse.json({ error: 'יש לשלוח את ההערה לשומר (guard_note)' }, { status: 400 });
  }
  try {
    const done = await setChipOrderGuardNote(id, body.data.guard_note ?? null, { id: actor.id, name: actor.full_name ?? actor.username });
    if (!done) return NextResponse.json({ error: 'ההזמנה לא נמצאה' }, { status: 404 });
    return NextResponse.json({ ok: true, ...done });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/guard-note');
  }
}

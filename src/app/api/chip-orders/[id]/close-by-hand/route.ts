import { NextResponse } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCloseByHandBodySchema } from '@/lib/validation/requests';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { closeCancelByHand } from '@/lib/db/chipCloseByHand';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/close-by-hand — "סגירה ידנית" (27/11/2026): the
// way out of a "ביטול וזיכוי" that is stuck for good (Morning keeps refusing
// the credit document, or the refund step needs a person). SUPER ADMIN ONLY,
// by role, with a reason (2–500). It sends NOTHING to PayPlus or Morning: the
// order's waiting documents are stopped, its chips disabled, the order
// cancelled, and the order keeps for good who closed it, when, why and at
// which step (src/lib/db/chipCloseByHand.ts). Nobody is messaged.

async function superAdmin(): Promise<Actor | NextResponse> {
  try {
    const actor = await requireAdmin();
    if (actor.role !== 'super_admin') return NextResponse.json({ error: 'סגירה ידנית — לסופר אדמין בלבד' }, { status: 403 });
    return actor;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await superAdmin();
  if (actor instanceof NextResponse) return actor;
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderCloseByHandBodySchema);
  if (!body.ok) return body.response;
  try {
    const done = await closeCancelByHand(id, body.data.reason, { id: actor.id, name: actor.full_name ?? actor.username });
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...done });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/close-by-hand');
  }
}

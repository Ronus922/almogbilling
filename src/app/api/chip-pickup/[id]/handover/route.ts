import { NextResponse } from 'next/server';
import { requireChipPickup, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { parseJsonBody } from '@/lib/http/body';
import { chipPickupHandoverBodySchema } from '@/lib/validation/requests';
import { markChipOrderCollected } from '@/lib/db/chipOrders';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-pickup/[id]/handover — "נמסר" of the guard's pickup screen
// (CHIP_PICKUP_ROLES: guard, admin, super admin). Body: { person } — the
// person of the order who showed an ID.
//
// The order becomes collected exactly as "נאסף" of the management makes it
// (the same function, markChipOrderCollected) — and, like it, sends no message
// to anyone. What this route adds is narrower, not wider:
//   · ONLY an order that is READY moves; any other status is refused (409),
//     so this path can neither close an order that is still being prepared nor
//     touch one that is already closed;
//   · the person is required, and must be a person of THAT order — the name is
//     read from the database, never from the request;
//   · an order with no active chip is refused: there is nothing to hand over;
//   · who handed over, when, and who collected are stored on the order and in
//     the audit log, in the same transaction as the change;
//   · a hand-over cannot be undone from any screen, so one user is held to
//     HANDOVER_MAX_PER_WINDOW of them in ten minutes — far above a lobby desk,
//     far below a session that closes every ready order in one go.
// The answer carries nothing of the order.

const HANDOVER_MAX_PER_WINDOW = 30;
const HANDOVER_WINDOW_SEC = 10 * 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requireChipPickup();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipPickupHandoverBodySchema);
  if (!body.ok) return body.response;
  const limit = await checkRateLimit(`chip-handover:user:${actor.id}`, { max: HANDOVER_MAX_PER_WINDOW, windowSec: HANDOVER_WINDOW_SEC });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי מסירות בזמן קצר — נסו שוב בעוד כמה דקות' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }
  try {
    const done = await markChipOrderCollected(
      id,
      { id: actor.id, name: actor.full_name ?? actor.username },
      { via: 'pickup', collector: body.data.person },
    );
    if (!done) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-pickup/:id/handover');
  }
}

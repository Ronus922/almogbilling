import { NextResponse, after } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { writeAudit } from '@/lib/db/audit';
import { retryFailedDocuments } from '@/lib/db/chipOrderDocuments';
import { processDueDocuments } from '@/lib/chipOrders/documents';
import { badOrderId } from '@/lib/chipOrders/routeErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chip-orders/[id]/documents/retry — "הפק חשבונית שוב" (26/11/2026).
// ADMIN AND SUPER ADMIN ONLY, by role: the order's Morning documents that
// FAILED go back to the queue now, with their attempts reset, and the queue is
// given a turn right after the answer. A document that is issued, or still
// waiting, is not touched — so a second press can never make a second
// document (one document per payment, ever: chip_order_documents.payment_key).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const queued = await retryFailedDocuments(id);
  if (queued > 0) {
    after(async () => {
      await writeAudit({ actorUserId: actor.id, action: 'documents_retry', entityType: 'chip_order', entityId: id, metadata: { queued } });
      await processDueDocuments();
    });
  }
  return NextResponse.json({ ok: true, queued });
}

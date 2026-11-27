import { NextResponse, after } from 'next/server';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCancelBodySchema } from '@/lib/validation/requests';
import { badOrderId, chipOrderErrorResponse } from '@/lib/chipOrders/routeErrors';
import { runCancelAndCredit } from '@/lib/chipOrders/receptionCancel';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { getReceptionCancelPreview } from '@/lib/db/chipReceptionCancel';
import { processDueDocuments } from '@/lib/chipOrders/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /api/chip-orders/[id]/cancel — "ביטול וזיכוי" (27/11/2026): the one way
// back for EVERY order — a reception order ("בטל הזמנת קבלה" before) and a
// web order the card paid ("זיכוי" before). ADMIN AND SUPER ADMIN ONLY, by
// role (requireAdmin): an order records money that was received, so undoing
// one is not part of issuing chips — a manager who may record a payment may
// not cancel it, and the guard never reaches it.
//
// GET  — what the confirmation states: the amount, how it was paid, where the
//        credit document is emailed, the chips the cancellation disables, a
//        cancellation PayPlus showed (payplus_reversal), and the steps so far
//        (which one failed, and why).
// POST — runs the steps in order (src/lib/chipOrders/receptionCancel.ts): the
//        refund in PayPlus (a card — the one refund of the module; skipped,
//        and recorded, when PayPlus already shows it cancelled or refunded),
//        the credit document in Morning, then the order cancelled and its
//        chips disabled (never deleted). A failed step answers 200 with
//        `ok: false`, the step and its words (the order shows them); POST
//        again = the remaining steps only. The reason is required the first
//        time. A reception order: no message to anyone (Morning emails the
//        credit). A web order: once done, the orderer gets the "זוכתה"
//        message (email + WhatsApp), as "זיכוי" sent it.

async function admin(): Promise<Actor | NextResponse> {
  try {
    return await requireAdmin();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await admin();
  if (actor instanceof NextResponse) return actor;
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  try {
    const preview = await getReceptionCancelPreview(id);
    if (!preview) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(preview, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return chipOrderErrorResponse(err, 'GET /api/chip-orders/:id/cancel');
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await admin();
  if (actor instanceof NextResponse) return actor;
  const { id } = await ctx.params;
  const bad = badOrderId(id);
  if (bad) return bad;
  const body = await parseJsonBody(req, chipOrderCancelBodySchema);
  if (!body.ok) return body.response;
  try {
    const by = { id: actor.id, name: actor.full_name ?? actor.username };
    const run = await runCancelAndCredit(id, body.data.reason ?? null, by);
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const chipsDisabled = run.chipsDisabled;
    after(async () => {
      // Whatever else is due in the queue (never this order's steps — they ran).
      await processDueDocuments();
      if (run.kind === 'done' && run.source === 'web') await notifyChipOrder(id, 'refunded', { chipsDisabled });
    });
    return NextResponse.json({
      ok: run.kind === 'done',
      order_number: run.orderNumber,
      source: run.source,
      failed_step: run.failedStep,
      message: run.message,
      refund: run.refund,
      credit_numbers: run.creditNumbers,
      credit_email: run.creditEmail,
      chips_disabled: run.chipsDisabled,
    });
  } catch (err) {
    return chipOrderErrorResponse(err, 'POST /api/chip-orders/:id/cancel');
  }
}

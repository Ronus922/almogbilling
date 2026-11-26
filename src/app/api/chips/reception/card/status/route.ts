import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { logger } from '@/lib/logger';
import { getCardOrderByToken } from '@/lib/db/chipOrderCard';
import { lookupCardPayment, lookupConfigFor } from '@/lib/chipOrders/cardPayment';
import { processDueDocuments } from '@/lib/chipOrders/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chips/reception/card/status — "was the reception card payment
// paid?" (26/11/2026). Admin / super admin only. Answers from the DATABASE (the
// state the signed callback wrote); while the order still waits, the SERVER
// asks PayPlus about the order's own sessions (at most once every few seconds)
// and applies what PayPlus says — the window's word never pays anything.
// `charged: 'no'` only when PayPlus itself answered for every recent session.

const bodySchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/) });

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  const order = await getCardOrderByToken(body.data.token);
  if (!order || order.source !== 'reception' || !order.card_env) {
    return NextResponse.json({ ok: false, error: 'התשלום לא נמצא' }, { status: 404 });
  }
  if (order.card_status === 'paid') return NextResponse.json({ ok: true, state: 'paid', amount: order.total, order_number: order.order_number, order_id: order.id });
  if (order.status !== 'pending_payment') return NextResponse.json({ ok: false, error: 'התשלום אינו ממתין עוד' }, { status: 409 });
  const cfg = lookupConfigFor(order.card_env);
  let charged: 'no' | 'unknown' = 'unknown';
  let refused = order.card_status === 'failed';
  let looked = false; // PayPlus was asked THIS time (see the public status route)
  const slot = await checkRateLimit(`chip-reception:card-lookup:order:${order.id}`, { max: 1, windowSec: 4 });
  if (cfg && slot.allowed) {
    try {
      looked = true;
      const found = await lookupCardPayment(cfg, order);
      if (found.kind === 'paid') {
        after(() => processDueDocuments().then(() => undefined));
        return NextResponse.json({ ok: true, state: 'paid', amount: order.total, order_number: order.order_number, order_id: order.id });
      }
      if (found.kind === 'not_charged') {
        charged = 'no';
        refused = refused || found.refused;
      }
    } catch (e) {
      logger.warn('[chip-reception] payplus lookup failed', { orderId: order.id, message: (e as Error).name });
    }
  }
  const now = await getCardOrderByToken(body.data.token);
  if (now?.card_status === 'paid') return NextResponse.json({ ok: true, state: 'paid', amount: now.total, order_number: now.order_number, order_id: now.id });
  return NextResponse.json({ ok: true, state: refused ? 'failed' : 'pending', charged, looked });
}

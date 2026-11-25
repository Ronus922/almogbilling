import { NextResponse, after } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCardBodySchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { logger } from '@/lib/logger';
import { getCardOrderByToken } from '@/lib/db/chipOrderCard';
import type { CardPaymentState } from '@/lib/chipOrders/card';
import { cardStepConfig, lookupCardPayment } from '@/lib/chipOrders/cardPayment';
import { notifyChipOrder } from '@/lib/chipOrders/notify';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/payplus/status — "was this order paid?", asked
// by the order page after the processor's SDK reported a result.
//
// PUBLIC BY DESIGN, gated like the session route (the test link while PayPlus
// runs in sandbox; the order's own tracking token). It answers from the
// DATABASE — the state the signed callback wrote. When the order still waits,
// the SERVER asks PayPlus about the order's own payment sessions (the lookup),
// at most once every few seconds per order, and applies what PayPlus says.
// The browser's word is never the reason an order is paid: it only makes the
// server look.
//
// `charged` tells the page whether a retry is safe: 'no' ONLY when PayPlus
// itself answered, in this very request, for every recent session of the
// order, and none holds an approved charge. Anything else — the lookup was
// throttled, PayPlus did not answer — is 'unknown', and the page keeps the
// customer from paying a second time.

const answer = (state: CardPaymentState, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: true, state, ...extra }, { headers: H });
const err = (status: number, message: string) =>
  NextResponse.json({ ok: false, message }, { status, headers: H });

export async function POST(req: Request) {
  const test = await isTestRequest(req);
  const cfg = cardStepConfig();
  if (!cfg || !test) return err(403, 'ההזמנות ייפתחו בקרוב.');

  const ipLimit = await checkRateLimit(`chip-order:card-status:ip:${getClientIp(req)}`, { max: 240, windowSec: 600 });
  if (!ipLimit.allowed) return err(429, 'יותר מדי בקשות. נסו שוב בעוד רגע.');

  const body = await parseJsonBody(req, chipOrderCardBodySchema);
  if (!body.ok) return body.response;

  const order = await getCardOrderByToken(body.data.trackingToken);
  if (!order || !order.is_test || order.source !== 'web' || order.card_env !== cfg.mode) {
    return err(409, 'ההזמנה אינה ממתינה לתשלום.');
  }
  if (order.status !== 'pending_payment') {
    // Paid (the callback got here first), or closed since.
    return order.card_status === 'paid' ? answer('paid', { orderNumber: order.order_number }) : err(409, 'ההזמנה אינה ממתינה לתשלום.');
  }

  // Still waiting: ask PayPlus — but not on every poll of the page.
  let charged: 'no' | 'unknown' = 'unknown';
  let refused = order.card_status === 'failed';
  const mayLookUp = await checkRateLimit(`chip-order:card-lookup:order:${order.id}`, { max: 1, windowSec: 4 });
  if (mayLookUp.allowed) {
    try {
      const found = await lookupCardPayment(cfg, order);
      if (found.kind === 'paid') {
        if (found.transitioned) after(() => notifyChipOrder(found.orderId, 'paid'));
        return answer('paid', { orderNumber: order.order_number });
      }
      if (found.kind === 'not_charged') {
        charged = 'no';
        refused = refused || found.refused;
      }
    } catch (e) {
      logger.warn('[chip-order] payplus lookup failed', { orderId: order.id, message: (e as Error).name });
    }
  }
  // The callback may have landed while we were asking.
  const now = await getCardOrderByToken(body.data.trackingToken);
  if (now && now.status !== 'pending_payment' && now.card_status === 'paid') return answer('paid', { orderNumber: now.order_number });
  return answer(refused ? 'failed' : 'pending', { charged });
}

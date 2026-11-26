import { NextResponse, after } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderCardBodySchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { appUrl } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { agorot, getCardOrderByToken, setCardSession } from '@/lib/db/chipOrderCard';
import { createHostedFieldsSession, disablePaymentRequest, PayPlusApiError } from '@/lib/payplus/client';
import { priceLine } from '@/lib/chipOrders/model';
import { cardHolderPhone, type CardSession } from '@/lib/chipOrders/card';
import { cardConfigFor, lookupCardPayment, orderMayPayByCard } from '@/lib/chipOrders/cardPayment';
import { afterOrderPaid } from '@/lib/chipOrders/notify';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { chipOrdersOpen, CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/payplus/session — opens a card payment session
// (PayPlus hosted fields) for an order that ALREADY EXISTS and still waits for
// payment. The browser sends the order's tracking token and nothing else.
//
// PUBLIC BY DESIGN (the order page has no login), gated like the page itself:
//   - with the CURRENT test-link token: the sandbox (always), and only for a
//     TEST order;
//   - without it: production, only while real charging is armed and the page
//     is open (cardPayment.ts / server.ts), and only for a REAL order — a
//     session's environment is always the order's kind;
//   - the order is found by its tracking token (32 random bytes — held by the
//     browser that saved the order) and must still be pending_payment;
//   - flat ceilings per IP and per order.
// THE AMOUNT IS COMPUTED HERE: all chips of the saved order × the price of the
// settings, and it must equal the total frozen on the order — otherwise no
// session. Nothing about the amount is read from the request.
//
// BEFORE A NEW SESSION IS OPENED the server asks PayPlus about the order's
// earlier sessions: an approved charge that is already there pays the order
// now (the answer is 409 with state 'paid'), and no second session is opened.
// When PayPlus cannot say what happened on an earlier session, none is opened
// either — a customer is never handed a fresh way to pay while an earlier
// charge is not ruled out.
//
// The answer carries only what the SDK needs: page_request_uid,
// hosted_fields_uuid, origin. The keys never leave the server.

const err = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, message, ...extra }, { status, headers: H });

export async function POST(req: Request) {
  const test = await isTestRequest(req);
  const cfg = cardConfigFor(test);
  if (!cfg || (!test && !chipOrdersOpen(await getChipOrderSettings()))) return err(403, 'ההזמנות ייפתחו בקרוב.');

  const ip = getClientIp(req);
  const ipLimit = await checkRateLimit(`chip-order:card-session:ip:${ip}`, { max: 60, windowSec: 3600 });
  if (!ipLimit.allowed) return err(429, 'יותר מדי ניסיונות תשלום מהמכשיר הזה. נסו שוב מאוחר יותר.');

  const body = await parseJsonBody(req, chipOrderCardBodySchema);
  if (!body.ok) return body.response;

  const order = await getCardOrderByToken(body.data.trackingToken);
  if (!order || !orderMayPayByCard(cfg, order)) return err(409, 'ההזמנה אינה ממתינה לתשלום.');

  const orderLimit = await checkRateLimit(`chip-order:card-session:order:${order.id}`, { max: 20, windowSec: 1800 });
  if (!orderLimit.allowed) return err(429, 'נפתחו יותר מדי חלונות תשלום להזמנה הזו. נסו שוב בעוד כחצי שעה.');

  // The price of the settings × the chips of the saved order — and the total
  // the order was saved with must be exactly that.
  const settings = await getChipOrderSettings();
  const amount = priceLine(order.chips, settings).lineTotal;
  if (order.chips <= 0 || amount <= 0 || agorot(amount) !== agorot(order.total)) {
    logger.warn('[chip-order] card session refused: the order total is not chips × the configured price', { orderId: order.id });
    // The form saves the order again (priced anew) and asks once more.
    return err(409, 'מחיר הכרטיס עודכן מאז שנשמרה ההזמנה.', { state: 'price_changed' });
  }
  if (!order.email) return err(409, 'ההזמנה אינה ממתינה לתשלום.');

  // An earlier session of this order: was it charged?
  if (order.card_page_request_uid) {
    let earlier;
    try {
      earlier = await lookupCardPayment(cfg, order);
    } catch (e) {
      logger.warn('[chip-order] payplus lookup failed before a new session', { orderId: order.id, message: (e as Error).name });
      earlier = { kind: 'unknown' } as const;
    }
    if (earlier.kind === 'paid') {
      if (earlier.transitioned) {
        const paidOrderId = earlier.orderId;
        after(() => afterOrderPaid(paidOrderId));
      }
      return err(409, 'ההזמנה כבר שולמה.', { state: 'paid' });
    }
    if (earlier.kind === 'unknown') {
      return err(502, 'לא ניתן לבדוק כרגע את ניסיון התשלום הקודם, ולכן לא נפתח חלון תשלום חדש. נסו שוב בעוד כמה דקות.');
    }
    // Nothing was charged on it: the previous session is killed, so the only
    // live way to pay the order is the one opened now.
    await disablePaymentRequest(cfg, order.card_page_request_uid);
  }

  const base = appUrl();
  let session;
  try {
    session = await createHostedFieldsSession(cfg, {
      amount,
      orderNumber: order.order_number,
      pageOrigin: new URL(base).origin,
      callbackUrl: `${base}/api/public/chip-order/payplus/callback?env=${cfg.mode}`,
      customer: { name: order.full_name, email: order.email, phone: cardHolderPhone(order.phone_e164) || null },
    });
  } catch (e) {
    const detail = e instanceof PayPlusApiError
      ? { endpoint: e.endpoint, status: e.status, message: e.message }
      : { message: (e as Error).name };
    logger.error('[chip-order] payplus generateLink failed', { orderId: order.id, ...detail });
    return err(502, 'לא ניתן לפתוח את התשלום כרגע. נסו שוב בעוד כמה דקות.');
  }

  // Stored only while the order still waits, at THIS amount; otherwise the
  // page request just opened is disabled and never handed out.
  if (!(await setCardSession(order.id, { env: cfg.mode, pageRequestUid: session.pageRequestUid, amount }))) {
    await disablePaymentRequest(cfg, session.pageRequestUid);
    const now = await getCardOrderByToken(body.data.trackingToken);
    if (now && orderMayPayByCard(cfg, now) && agorot(now.total) !== agorot(amount)) {
      // The order was saved with another total meanwhile: the form saves it
      // again and asks once more.
      return err(409, 'סכום ההזמנה השתנה בזמן פתיחת התשלום.', { state: 'price_changed' });
    }
    return err(409, 'ההזמנה אינה ממתינה לתשלום.');
  }
  const answer: CardSession & { ok: true; amount: number } = {
    ok: true,
    page_request_uid: session.pageRequestUid,
    hosted_fields_uuid: session.hostedFieldsUuid,
    origin: cfg.origin,
    // What this session charges — the page re-opens a session when the order's total moves.
    amount,
  };
  return NextResponse.json(answer, { headers: H });
}

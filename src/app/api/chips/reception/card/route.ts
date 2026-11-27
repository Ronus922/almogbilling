import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { requireAdmin, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { appUrl } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { ReceptionError, createReceptionCardOrder } from '@/lib/db/chipReception';
import { agorot, getCardOrderByToken, setCardSession } from '@/lib/db/chipOrderCard';
import { createHostedFieldsSession, disablePaymentRequest, PayPlusApiError } from '@/lib/payplus/client';
import { cardHolderPhone } from '@/lib/chipOrders/card';
import { liveCardConfig, lookupCardPayment, receptionOrderMayPayByCard, testCardConfig } from '@/lib/chipOrders/cardPayment';
import { receptionAmount } from '@/lib/chipOrders/reception';
import { processDueDocuments } from '@/lib/chipOrders/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/chips/reception/card — "אשראי" in the issue window without an
// order (26/11/2026). ADMIN AND SUPER ADMIN ONLY, by role (requireAdmin) — the
// guard never reaches it. The same server rules as the public page:
//   - the amount is computed HERE: the new chips of the window × the price of
//     /settings, frozen on a reception order that waits for the payment
//     (createReceptionCardOrder) — never read from the request;
//   - a payment session (PayPlus hosted fields) is opened for THAT order; the
//     charge pays it only through the signed callback or our lookup, exactly
//     like a web order (recordCardPayment — one transaction, idempotent);
//   - `test: true` is the clearly marked TEST mode: the PayPlus SANDBOX and a
//     TEST reception order (deleted like any test order, never a Morning
//     document). Without it, a real charge needs live charging armed.
// `token` renews the session of an order this window already opened (expired,
// out of attempts): only for the same apartment, chips and amount, and only
// after PayPlus answered that nothing was charged on the earlier session.
//
// The answer carries the order's token (the window sends it with the save),
// its number, the amount, and what the SDK needs. No card data ever reaches us.

const bodySchema = z.object({
  contact_id: z.uuid(),
  new_chips: z.number().int().min(1).max(50),
  test: z.boolean(),
  role: z.enum(['owner', 'tenant', 'operator', 'other', 'staff']),
  orderer: z.object({
    name: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).nullable().optional(),
    street: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().max(100).nullable().optional(),
    zip: z.string().trim().max(20).nullable().optional(),
  }),
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
});

const err = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requireAdmin();
  } catch (e) {
    const r = authErrorResponse(e);
    if (r) return r;
    throw e;
  }
  const body = await parseJsonBody(req, bodySchema);
  if (!body.ok) return body.response;
  const b = body.data;
  const cfg = b.test ? testCardConfig() : liveCardConfig();
  if (!cfg) {
    return err(403, b.test ? 'סביבת הבדיקות של PayPlus אינה מוגדרת בשרת' : 'תשלום באשראי אמיתי אינו פעיל עדיין — אפשר לנסות במצב בדיקה');
  }
  const limit = await checkRateLimit(`chip-reception:card-session:user:${actor.id}`, { max: 30, windowSec: 3600 });
  if (!limit.allowed) return err(429, 'נפתחו יותר מדי חלונות תשלום. נסו שוב מאוחר יותר.');

  const { unitPrice } = await getChipOrderSettings();
  const amount = receptionAmount(b.new_chips, unitPrice);
  const by = { id: actor.id, name: actor.full_name ?? actor.username };

  let order;
  let token: string | null = b.token ?? null;
  if (b.token) {
    order = await getCardOrderByToken(b.token);
    if (!order || !receptionOrderMayPayByCard(cfg, order)) {
      if (order?.source === 'reception' && order.card_status === 'paid') return err(409, 'התשלום כבר בוצע', { state: 'paid', amount: order.total, order_id: order.id });
      return err(409, 'התשלום הקודם אינו ממתין עוד — יש לפתוח תשלום חדש', { state: 'stale' });
    }
    if (order.chips !== b.new_chips || agorot(order.total) !== agorot(amount)) {
      return err(409, 'מספר הצ׳יפים או המחיר השתנו — יש לפתוח תשלום חדש', { state: 'stale' });
    }
    // Was anything charged on its earlier session?
    if (order.card_page_request_uid) {
      let earlier;
      try {
        earlier = await lookupCardPayment(cfg, order);
      } catch {
        earlier = { kind: 'unknown' } as const;
      }
      if (earlier.kind === 'paid') {
        after(() => processDueDocuments().then(() => undefined));
        return err(409, 'התשלום כבר בוצע', { state: 'paid', amount: order.total, order_id: order.id });
      }
      if (earlier.kind === 'unknown') return err(502, 'לא ניתן לבדוק כרגע את ניסיון התשלום הקודם, ולכן לא נפתח חלון תשלום חדש. נסו שוב בעוד כמה דקות.');
      await disablePaymentRequest(cfg, order.card_page_request_uid);
    }
  } else {
    try {
      const created = await createReceptionCardOrder({
        contactId: b.contact_id, newChips: b.new_chips, unitPrice, isTest: b.test, role: b.role,
        orderer: {
          name: b.orderer.name ?? null, phone: b.orderer.phone ?? null, email: b.orderer.email || null,
          street: b.orderer.street ?? null, city: b.orderer.city ?? null, zip: b.orderer.zip ?? null,
        },
      }, by);
      token = created.tracking_token;
      order = await getCardOrderByToken(created.tracking_token);
    } catch (e) {
      if (e instanceof ReceptionError) {
        const text: Record<string, string> = {
          name_too_short: 'יש למלא שם מזמין (לפחות שתי אותיות) לפני תשלום באשראי',
          name_too_long: 'שם המזמין ארוך מדי',
          too_many_chips: 'בתשלום בקבלה אפשר להנפיק עד 50 צ׳יפים בשמירה אחת',
          nothing_to_charge: 'אין סכום לגבייה',
        };
        return err(400, text[e.code] ?? 'לא ניתן לפתוח תשלום', { code: e.code });
      }
      if (e instanceof Error && e.message === 'contact_not_found') return err(404, 'הדירה לא נמצאה');
      throw e;
    }
    if (!order) return err(500, 'server_error');
  }

  const base = appUrl();
  let session;
  try {
    session = await createHostedFieldsSession(cfg, {
      amount: order.total,
      orderNumber: order.order_number,
      pageOrigin: new URL(base).origin,
      callbackUrl: `${base}/api/public/chip-order/payplus/callback?env=${cfg.mode}`,
      customer: { name: order.full_name, email: order.email, phone: cardHolderPhone(order.phone_e164) || null },
    });
  } catch (e) {
    const detail = e instanceof PayPlusApiError ? { endpoint: e.endpoint, status: e.status, message: e.message } : { message: (e as Error).name };
    logger.error('[chip-reception] payplus generateLink failed', { orderId: order.id, ...detail });
    return err(502, 'לא ניתן לפתוח את התשלום כרגע. נסו שוב בעוד כמה דקות.');
  }
  // Stored only while the order still waits at this amount; otherwise the page
  // request just opened is disabled and never handed out.
  if (!(await setCardSession(order.id, { env: cfg.mode, pageRequestUid: session.pageRequestUid, amount: order.total }))) {
    await disablePaymentRequest(cfg, session.pageRequestUid);
    return err(409, 'התשלום אינו ממתין עוד — יש לפתוח תשלום חדש', { state: 'stale' });
  }
  return NextResponse.json({
    ok: true,
    token,
    order_id: order.id,
    order_number: order.order_number,
    amount: order.total,
    test: b.test,
    session: { page_request_uid: session.pageRequestUid, hosted_fields_uuid: session.hostedFieldsUuid, origin: cfg.origin, amount: order.total },
  });
}

import { NextResponse, after } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrderPaymentRef } from '@/lib/db/chipOrders';
import { approveTransaction, flattenGrowCallback, flattenGrowJson } from '@/lib/grow/client';
import { callbackSignatureValid } from '@/lib/chipOrders/server';
import { afterChipOrderPaid, confirmChipOrderPayment } from '@/lib/chipOrders/payment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/grow/notify?o=<order>&s=<sig> — Grow's
// server-to-server callback after a payment (R/server-to-server-callback).
//
// PUBLIC BY DESIGN (Grow calls it), and the callback itself is NOT trusted:
//   1. `s` must be OUR HMAC of the order id (Grow signs nothing) → else 403;
//   2. the callback's processId / processToken must be the ones stored when
//      the process was created (the token never left our server) → else 403;
//   3. the payment is confirmed by asking Grow (getPaymentProcessInfo with our
//      stored process): a transaction with statusCode 2 ("שולם") and exactly
//      the order's total. Only then pending_payment → paid.
// Then approveTransaction acknowledges the callback (Grow re-sends until it
// gets one). A failed verification is answered 200 WITHOUT the
// acknowledgement, so Grow tries again later.

async function readFields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return flattenGrowJson(await req.json().catch(() => ({})));
  try {
    const form = await req.formData();
    return flattenGrowCallback(form.entries());
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const orderId = url.searchParams.get('o') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(orderId) || !callbackSignatureValid('notify', orderId, url.searchParams.get('s'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const fields = await readFields(req);
  const order = await getOrderPaymentRef(orderId);
  if (!order || !order.grow_process_id || !order.grow_process_token) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (
    (fields.processId && fields.processId !== order.grow_process_id) ||
    (fields.processToken && fields.processToken !== order.grow_process_token)
  ) {
    logger.warn('[chip-order] grow callback with a foreign process', { orderId });
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const check = await confirmChipOrderPayment(orderId, 'grow_callback');
  if (check.kind !== 'paid') {
    // Not (yet) verifiable — answered WITHOUT the acknowledgement, so Grow sends
    // the callback again later.
    if (check.kind === 'not_paid') logger.warn('[chip-order] grow callback without a paid transaction of the order total', { orderId });
    return NextResponse.json({ ok: false });
  }
  after(async () => {
    await approveTransaction(fields);
    if (check.transitioned) await afterChipOrderPaid(orderId, 'grow_callback');
  });
  return NextResponse.json({ ok: true });
}

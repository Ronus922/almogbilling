import { NextResponse, after } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderTestFinishBodySchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { appUrl } from '@/lib/config';
import { markTestChipOrderPaid } from '@/lib/db/chipOrders';
import { CONSENT_REQUIRED, consentMissing, getCardOrderByToken } from '@/lib/db/chipOrderCard';
import { afterChipOrderPaid } from '@/lib/chipOrders/payment';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { testCardConfig } from '@/lib/chipOrders/cardPayment';
import { CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/public/chip-order/test-finish — "סיים הזמנת בדיקה" (test mode,
// 13/11/2026). The payment step of a TEST order while the PayPlus sandbox is
// not configured (CI): the order becomes "paid" with is_test, no processor
// field, no invoice — then the usual audit row and "received & paid" message
// (marked [בדיקה]).
//
// PUBLIC BY DESIGN, and 403 unless the request carries the CURRENT test-link
// token (switch on, latest link). The UPDATE is locked to is_test AND
// pending_payment, matched by the order's tracking token — it can never touch
// an order created without the test link.
//
// Card payment (25/11/2026): while the PayPlus sandbox is configured a test
// order is paid with the sandbox card, and becomes paid only from PayPlus (its
// signed callback or our lookup). This shortcut is then closed — 409 — so
// there is no way to mark an order paid from the browser.
export async function POST(req: Request) {
  if (!(await isTestRequest(req))) {
    return NextResponse.json({ ok: false, message: 'ההזמנות ייפתחו בקרוב.' }, { status: 403, headers: H });
  }
  if (testCardConfig()) {
    return NextResponse.json({ ok: false, message: 'הזמנת בדיקה משולמת עכשיו בכרטיס בדיקה, בשלב התשלום של הטופס.' }, { status: 409, headers: H });
  }
  const limit = await checkRateLimit(`chip-order:test-finish:ip:${getClientIp(req)}`, { max: 20, windowSec: 3600 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, message: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' }, { status: 429, headers: H });
  }
  const body = await parseJsonBody(req, chipOrderTestFinishBodySchema);
  if (!body.ok) return body.response;

  // Decision 3.5: the agreement boxes, recorded on the order, before it is "paid".
  const current = await getCardOrderByToken(body.data.trackingToken);
  if (current && consentMissing(current)) {
    return NextResponse.json({ ok: false, message: CONSENT_REQUIRED, state: 'terms_required' }, { status: 409, headers: H });
  }
  const orderId = await markTestChipOrderPaid(body.data.trackingToken);
  if (!orderId) {
    return NextResponse.json({ ok: false, message: 'הזמנת הבדיקה לא נמצאה או שכבר הושלמה.' }, { status: 409, headers: H });
  }
  after(() => afterChipOrderPaid(orderId, 'test_finish'));
  return NextResponse.json(
    { ok: true, trackUrl: `${appUrl()}/chip-order/track/${body.data.trackingToken}` },
    { headers: H },
  );
}

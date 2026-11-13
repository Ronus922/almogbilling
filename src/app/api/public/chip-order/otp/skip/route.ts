import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderOtpSkipBodySchema } from '@/lib/validation/requests';
import { toPortalE164 } from '@/lib/portal/phone';
import { chipOrdersOpen, setSkippedPhoneCookie, CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { getChipOrderSettings } from '@/lib/db/appSettings';

export const runtime = 'nodejs';

// POST /api/public/chip-order/otp/skip — "דלג על אימות (מצב בדיקה)" (13/11/2026).
//
// TEST MODE ONLY. With SMS credit at 0 no code reached Ronen's phone, so a test
// order could not be created at all. With the CURRENT test-link token (switch
// on) this marks the typed phone as "code skipped" in a sealed cookie of its
// own; the order submit then creates a test order stored phone_verified =
// false. Anything else — no token, a wrong one, the switch off, and also the
// page open to the public without a token — is 403: a real order always needs
// a verified code. The refusal gives no hint that test mode exists: the same
// words the page's other routes use.
//
// Nothing here issues, reads or consumes a code, touches a rate-limit bucket,
// or calls a provider (019 / Green API).

export async function POST(req: Request) {
  if (!(await isTestRequest(req))) {
    const message = chipOrdersOpen(await getChipOrderSettings())
      ? 'יש לאמת את מספר הטלפון בקוד לפני התשלום.'
      : 'ההזמנות ייפתחו בקרוב.';
    return NextResponse.json({ ok: false, message }, { status: 403, headers: H });
  }
  const body = await parseJsonBody(req, chipOrderOtpSkipBodySchema);
  if (!body.ok) return body.response;

  const phoneE164 = toPortalE164(body.data.phone);
  if (!phoneE164 || !phoneE164.startsWith('+9725')) {
    return NextResponse.json({ ok: false, message: 'נדרש מספר טלפון נייד ישראלי.' }, { status: 400, headers: H });
  }

  await setSkippedPhoneCookie(phoneE164);
  return NextResponse.json({ ok: true, skipped: true }, { headers: H });
}

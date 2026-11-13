import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderOtpVerifyBodySchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { toPortalE164 } from '@/lib/portal/phone';
import { verifyCode } from '@/lib/db/portal/otp';
import { chipOrdersOpen, setVerifiedPhoneCookie, CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { PORTAL_OTP_IP_WINDOW_SEC, PORTAL_OTP_MAX_ATTEMPTS, PORTAL_VERIFY_MAX_PER_IP } from '@/lib/constants/portal';

export const runtime = 'nodejs';

// POST /api/public/chip-order/otp/verify — the code typed on /chip-order.
//
// PUBLIC BY DESIGN (pre-auth). The portal's own verifyCode with purpose
// 'chip_order': only the NEWEST chip-order code of the phone counts, wrong
// guesses are counted on that code — each one RESERVES its attempt atomically
// before the compare, so parallel guesses cannot exceed
// PORTAL_OTP_MAX_ATTEMPTS per code — and then a new code must be requested.
// Success seals the phone into an httpOnly cookie (30 minutes) that the order
// submit requires. Like every write of the page: only while it is open, or
// with the CURRENT test-link token (test mode).

export async function POST(req: Request) {
  if (!chipOrdersOpen(await getChipOrderSettings()) && !(await isTestRequest(req))) {
    return NextResponse.json({ ok: false, message: 'ההזמנות ייפתחו בקרוב.' }, { status: 403, headers: H });
  }
  const body = await parseJsonBody(req, chipOrderOtpVerifyBodySchema);
  if (!body.ok) return body.response;

  const ip = getClientIp(req);
  const ipLimit = await checkRateLimit(`chip-order:verify:ip:${ip}`, {
    max: PORTAL_VERIFY_MAX_PER_IP,
    windowSec: PORTAL_OTP_IP_WINDOW_SEC,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { ok: false, message: 'יותר מדי ניסיונות מהמכשיר הזה. נסו שוב מאוחר יותר.' },
      { status: 429, headers: { ...H, 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  const phoneE164 = toPortalE164(body.data.phone);
  if (!phoneE164 || !phoneE164.startsWith('+9725')) {
    return NextResponse.json({ ok: false, message: 'נדרש מספר טלפון נייד ישראלי.' }, { status: 400, headers: H });
  }

  const outcome = await verifyCode(phoneE164, body.data.code, 'chip_order', PORTAL_OTP_MAX_ATTEMPTS);
  if (outcome.kind === 'ok') {
    await setVerifiedPhoneCookie(phoneE164);
    return NextResponse.json({ ok: true }, { headers: H });
  }
  if (outcome.kind === 'invalid') {
    const left = Math.max(0, PORTAL_OTP_MAX_ATTEMPTS - outcome.attempts);
    if (left === 0) {
      return NextResponse.json(
        { ok: false, expired: true, message: 'הוזן קוד שגוי יותר מדי פעמים. בקשו קוד חדש.' },
        { status: 400, headers: H },
      );
    }
    return NextResponse.json(
      { ok: false, attemptsLeft: left, message: left === 1 ? 'הקוד שגוי. נותר ניסיון אחרון.' : `הקוד שגוי. נותרו ${left} ניסיונות.` },
      { status: 400, headers: H },
    );
  }
  return NextResponse.json(
    { ok: false, expired: true, message: 'תוקף הקוד פג. בקשו קוד חדש.' },
    { status: 400, headers: H },
  );
}

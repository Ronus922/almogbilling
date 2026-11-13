import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderOtpRequestBodySchema } from '@/lib/validation/requests';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { getClientIp } from '@/lib/http/clientIp';
import { toPortalE164 } from '@/lib/portal/phone';
import { sendPortalCode } from '@/lib/portal/send';
import { resolveDefaultChannel } from '@/lib/portal/otpChannel';
import { issueCode, resendCooldownRemaining } from '@/lib/db/portal/otp';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { chipOrdersOpen, CHIP_ORDER_PUBLIC_HEADERS as H } from '@/lib/chipOrders/server';
import { isTestRequest } from '@/lib/chipOrders/testMode';
import { CHIP_ORDER_LIMITS } from '@/lib/chipOrders/model';
import {
  PORTAL_OTP_DAY_WINDOW_SEC, PORTAL_OTP_HOUR_WINDOW_SEC, PORTAL_OTP_IP_WINDOW_SEC, PORTAL_OTP_MAX_PER_DAY,
  PORTAL_OTP_MAX_PER_HOUR, PORTAL_OTP_MAX_PER_IP, PORTAL_OTP_MAX_REQUESTS_PER_WINDOW,
  PORTAL_OTP_REQUEST_WINDOW_SEC, PORTAL_OTP_RESEND_COOLDOWN_SEC, PORTAL_OTP_TOO_MANY_MESSAGE,
} from '@/lib/constants/portal';

export const runtime = 'nodejs';

// POST /api/public/chip-order/otp/request — "שלח קוד אימות" on /chip-order.
//
// PUBLIC BY DESIGN (pre-auth, like the portal's own request route): it only
// sends a code to the phone that was typed, and reveals nothing. It IS the
// portal's OTP — the same code generator, bcrypt hash, 5-minute TTL, 45s
// resend cooldown and SMS-first / WhatsApp channel (sendPortalCode) — with
// purpose 'chip_order', so the code can never open a portal session and a
// portal login never consumes it.
//
// Unlike the portal there is no roster check (anyone may order) and no
// lockout ladder (a lockout would also lock the person out of the portal);
// the ceilings are flat 429s: per IP, per phone per 15 minutes / hour / day,
// and a daily ceiling for ALL chip-order codes together (an SMS costs money and
// any Israeli mobile can be typed here).
// The phone must be an Israeli mobile — Grow's payment page requires one.
// Open = the page is open, or the request carries the CURRENT test-link token
// (test mode — the same code, the same ceilings).

export async function POST(req: Request) {
  if (!chipOrdersOpen(await getChipOrderSettings()) && !(await isTestRequest(req))) {
    return NextResponse.json({ ok: false, message: 'ההזמנות ייפתחו בקרוב.' }, { status: 403, headers: H });
  }
  const body = await parseJsonBody(req, chipOrderOtpRequestBodySchema);
  if (!body.ok) return body.response;

  const phoneE164 = toPortalE164(body.data.phone);
  if (!phoneE164 || !phoneE164.startsWith('+9725')) {
    return NextResponse.json({ ok: false, message: 'נדרש מספר טלפון נייד ישראלי.' }, { status: 400, headers: H });
  }

  const ip = getClientIp(req);
  const limits: { key: string; max: number; windowSec: number; message: string }[] = [
    { key: `chip-order:otp:ip:${ip}`, max: PORTAL_OTP_MAX_PER_IP, windowSec: PORTAL_OTP_IP_WINDOW_SEC, message: 'יותר מדי בקשות מהמכשיר הזה. נסו שוב מאוחר יותר.' },
  ];
  for (const l of limits) {
    const r = await checkRateLimit(l.key, { max: l.max, windowSec: l.windowSec });
    if (!r.allowed) {
      return NextResponse.json({ ok: false, message: l.message }, { status: 429, headers: { ...H, 'Retry-After': String(r.retryAfterSec) } });
    }
  }

  const cooldown = await resendCooldownRemaining(phoneE164, 'chip_order');
  if (cooldown > 0) {
    return NextResponse.json(
      { ok: false, retryAfterSec: cooldown, message: `אפשר לבקש קוד חדש בעוד ${cooldown} שניות.` },
      { status: 429, headers: { ...H, 'Retry-After': String(cooldown) } },
    );
  }

  for (const [key, max, windowSec] of [
    ['chip-order:otp:all', CHIP_ORDER_LIMITS.otpPerDay, PORTAL_OTP_DAY_WINDOW_SEC],
    [`chip-order:otp:phone:${phoneE164}`, PORTAL_OTP_MAX_REQUESTS_PER_WINDOW, PORTAL_OTP_REQUEST_WINDOW_SEC],
    [`chip-order:otp:phone:hour:${phoneE164}`, PORTAL_OTP_MAX_PER_HOUR, PORTAL_OTP_HOUR_WINDOW_SEC],
    [`chip-order:otp:phone:day:${phoneE164}`, PORTAL_OTP_MAX_PER_DAY, PORTAL_OTP_DAY_WINDOW_SEC],
  ] as const) {
    const r = await checkRateLimit(key, { max, windowSec });
    if (!r.allowed) {
      return NextResponse.json(
        { ok: false, message: PORTAL_OTP_TOO_MANY_MESSAGE },
        { status: 429, headers: { ...H, 'Retry-After': String(r.retryAfterSec) } },
      );
    }
  }

  const { code } = await issueCode(phoneE164, ip, 'chip_order');
  const channel = body.data.channel ?? resolveDefaultChannel();
  const sent = await sendPortalCode(phoneE164, code, channel, req.headers.get('host'), 'chip_order');
  if (!sent.ok) {
    // The code row above already started the resend cooldown; the page waits
    // it out before it offers "שליחת הקוד בוואטסאפ במקום" (13/11/2026).
    return NextResponse.json(
      { ok: false, retryAfterSec: PORTAL_OTP_RESEND_COOLDOWN_SEC, message: 'שליחת הקוד נכשלה. נסו שוב בעוד רגע.' },
      { status: 502, headers: { ...H, 'Retry-After': String(PORTAL_OTP_RESEND_COOLDOWN_SEC) } },
    );
  }
  return NextResponse.json({ ok: true, sent: true, channel }, { headers: H });
}

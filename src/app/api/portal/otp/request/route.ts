import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { portalOtpRequestBodySchema } from '@/lib/validation/requests';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { toPortalE164 } from '@/lib/portal/phone';
import { sendPortalCode, alertManagerAboutLockout } from '@/lib/portal/send';
import { findPortalRegistration } from '@/lib/db/portal/identity';
import { issueCode, resendCooldownRemaining } from '@/lib/db/portal/otp';
import { activeLockout, createLockout, lockoutMinutesRemaining } from '@/lib/db/portal/lockouts';
import { logPortalEvent } from '@/lib/db/portal/events';
import {
  PORTAL_LOCKOUT_ALERT_TIER, PORTAL_NOT_OWNER_MESSAGE,
  PORTAL_OTP_IP_WINDOW_SEC, PORTAL_OTP_MAX_PER_IP,
  PORTAL_OTP_MAX_REQUESTS_PER_WINDOW, PORTAL_OTP_REQUEST_WINDOW_SEC,
  portalLockedMessage,
} from '@/lib/constants/portal';

export const runtime = 'nodejs';

// POST /api/portal/otp/request — "שלח קוד" on /portal/login.
//
// PUBLIC BY DESIGN (pre-auth, like /api/auth/login): it establishes nothing and
// reveals nothing but the one thing product decided to reveal — that a number is
// not registered as an owner, so the owner calls the management company instead
// of guessing. The response NEVER carries apartment details, a name, or the code.
//
// Order of checks (each one is a gate for the next):
//   lockout → IP ceiling → 60-second cooldown → ROSTER → per-phone window
//
// The roster moved AHEAD of the per-phone window on 29/09/2026. It used to sit
// last, so a number that is not an owner still spent a window slot on every
// tap — and the sixth tap locked it out for 30 minutes although no code had
// ever been sent to it. That is exactly what happened to apartment 1233 on
// 29/09 08:02–08:06 UTC: five `phone_not_found`, then `locked_out`
// (`too_many_code_requests`). The 60-second cooldown could not slow it down
// either, because that cooldown is measured on the newest portal_otp_codes row
// and an unregistered phone never gets one.
//
// Nothing is leaked by the new order: this endpoint already tells the caller
// outright that a number is not registered (a deliberate product decision —
// the owner should ring the management company, not guess). Enumeration is
// bounded by the per-IP ceiling above, which is what that ceiling is for. The
// per-phone window keeps its real job: stopping a REAL owner's phone from
// being flooded with WhatsApp codes.

export async function POST(req: Request) {
  const body = await parseJsonBody(req, portalOtpRequestBodySchema);
  if (!body.ok) return body.response;

  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent');
  const phoneE164 = toPortalE164(body.data.phone);

  // Not an Israeli mobile at all → the same answer an unregistered number gets.
  // Nothing is logged against a phone we cannot even name.
  if (!phoneE164) {
    return NextResponse.json({ ok: true, message: PORTAL_NOT_OWNER_MESSAGE });
  }

  const locked = await activeLockout(phoneE164);
  if (locked) {
    // The apartments go on the event so the block shows up on the apartment
    // card's log, not only on the admin screen (the card filters on this array).
    const known = await findPortalRegistration(phoneE164, { onlyActive: false });
    await logPortalEvent({
      phoneE164, eventType: 'locked_out', ip, userAgent,
      apartmentNumbers: known?.apartmentNumbers ?? [],
      details: { stage: 'request', tier: locked.tier, until: locked.locked_until },
    });
    return NextResponse.json(
      {
        ok: false, locked: true, lockedUntil: locked.locked_until,
        message: portalLockedMessage(lockoutMinutesRemaining(locked)),
      },
      { status: 429 },
    );
  }

  // Per-IP ceiling: a plain 429, never a lockout — an IP is shared, and locking
  // it would let one abuser shut out a whole household or office.
  const ipLimit = await checkRateLimit(`portal:otp:ip:${ip}`, {
    max: PORTAL_OTP_MAX_PER_IP,
    windowSec: PORTAL_OTP_IP_WINDOW_SEC,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { ok: false, message: 'יותר מדי בקשות מהמכשיר הזה. נסה שוב מאוחר יותר.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  const cooldown = await resendCooldownRemaining(phoneE164);
  if (cooldown > 0) {
    return NextResponse.json(
      { ok: false, retryAfterSec: cooldown, message: `נסה שוב בעוד ${cooldown} שניות.` },
      { status: 429, headers: { 'Retry-After': String(cooldown) } },
    );
  }

  // Roster lookup. onlyActive: false first, so a switched-off owner is logged as
  // phone_inactive rather than phone_not_found — the admin needs to tell a sold
  // apartment apart from a wrong number.
  const known = await findPortalRegistration(phoneE164, { onlyActive: false });
  const active = await findPortalRegistration(phoneE164, { onlyActive: true });

  if (!active) {
    await logPortalEvent({
      phoneE164,
      eventType: known ? 'phone_inactive' : 'phone_not_found',
      apartmentNumbers: known?.apartmentNumbers ?? [],
      ip, userAgent,
    });
    // 200 with the same message either way — the caller cannot tell the two
    // apart, and neither answer can ever lead to a lockout.
    return NextResponse.json({ ok: true, notRegistered: true, message: PORTAL_NOT_OWNER_MESSAGE });
  }

  const windowLimit = await checkRateLimit(`portal:otp:phone:${phoneE164}`, {
    max: PORTAL_OTP_MAX_REQUESTS_PER_WINDOW,
    windowSec: PORTAL_OTP_REQUEST_WINDOW_SEC,
  });
  if (!windowLimit.allowed) {
    const { lockout, countInWindow } = await createLockout(phoneE164, 'too_many_code_requests');
    await logPortalEvent({
      phoneE164, eventType: 'locked_out', ip, userAgent,
      apartmentNumbers: active.apartmentNumbers,
      details: { reason: 'too_many_code_requests', tier: lockout.tier, until: lockout.locked_until },
    });
    if (countInWindow >= PORTAL_LOCKOUT_ALERT_TIER) {
      await alertManagerAboutLockout(phoneE164);
    }
    return NextResponse.json(
      {
        ok: false, locked: true, lockedUntil: lockout.locked_until,
        message: portalLockedMessage(lockoutMinutesRemaining(lockout)),
      },
      { status: 429 },
    );
  }

  const { code } = await issueCode(phoneE164, ip);
  await logPortalEvent({
    phoneE164, eventType: 'code_requested',
    apartmentNumbers: active.apartmentNumbers, ip, userAgent,
  });

  const sent = await sendPortalCode(phoneE164, code);
  if (!sent.ok) {
    await logPortalEvent({
      phoneE164, eventType: 'send_failed',
      apartmentNumbers: active.apartmentNumbers, ip, userAgent,
      details: { error: sent.error },
    });
    return NextResponse.json(
      { ok: false, message: 'שליחת הקוד נכשלה. נסה שוב בעוד רגע, או פנה לחברת הניהול.' },
      { status: 502 },
    );
  }

  await logPortalEvent({
    phoneE164, eventType: 'code_sent',
    apartmentNumbers: active.apartmentNumbers, ip, userAgent,
  });
  return NextResponse.json({ ok: true, sent: true });
}

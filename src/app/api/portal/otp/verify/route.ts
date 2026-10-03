import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { portalOtpVerifyBodySchema } from '@/lib/validation/requests';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { toPortalE164 } from '@/lib/portal/phone';
import { alertManagerAboutLockout } from '@/lib/portal/send';
import { startPortalSession } from '@/lib/portal/session';
import { findPortalRegistration } from '@/lib/db/portal/identity';
import { verifyCode } from '@/lib/db/portal/otp';
import { activeLockout, createLockout, lockoutMinutesRemaining } from '@/lib/db/portal/lockouts';
import { logPortalEvent } from '@/lib/db/portal/events';
import {
  PORTAL_LOCKOUT_ALERT_TIER, PORTAL_NOT_OWNER_MESSAGE,
  PORTAL_OTP_IP_WINDOW_SEC, PORTAL_OTP_MAX_ATTEMPTS, PORTAL_VERIFY_MAX_PER_IP,
  portalLockedMessage, portalWrongCodeMessage,
} from '@/lib/constants/portal';

export const runtime = 'nodejs';

// POST /api/portal/otp/verify — the code the resident typed.
//
// PUBLIC BY DESIGN (pre-auth): this is the endpoint that ESTABLISHES the portal
// session, exactly as /api/auth/login establishes the staff one.
//
// The wrong-code ceiling is counted on the code row itself (attempts), not in a
// rate-limit bucket, so it cannot be spread across several live codes: asking for
// a new code invalidates the previous one (verifyCode only ever looks at the
// newest row).
//
// That ceiling alone does NOT cover a phone with no live code: once a code is
// consumed or expired every guess answers `code_expired` and nothing counts it,
// so an anonymous caller could hammer this endpoint forever and write a log row
// each time. Hence the per-IP ceiling below — the phone-based lockout protects
// the ACCOUNT, this protects portal_login_events from being flooded.

export async function POST(req: Request) {
  const body = await parseJsonBody(req, portalOtpVerifyBodySchema);
  if (!body.ok) return body.response;

  const ip = clientIp(req);
  const userAgent = req.headers.get('user-agent');
  const phoneE164 = toPortalE164(body.data.phone);
  if (!phoneE164) {
    return NextResponse.json({ ok: false, message: PORTAL_NOT_OWNER_MESSAGE }, { status: 400 });
  }

  // Per-IP ceiling, shared with the request endpoint's constant. A plain 429 and
  // deliberately NOT logged: logging it is exactly what is being rate-limited.
  const ipLimit = await checkRateLimit(`portal:verify:ip:${ip}`, {
    max: PORTAL_VERIFY_MAX_PER_IP,
    windowSec: PORTAL_OTP_IP_WINDOW_SEC,
  });
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { ok: false, message: 'יותר מדי ניסיונות מהמכשיר הזה. נסה שוב מאוחר יותר.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  const locked = await activeLockout(phoneE164);
  if (locked) {
    const known = await findPortalRegistration(phoneE164, { onlyActive: false });
    await logPortalEvent({
      phoneE164, eventType: 'locked_out', ip, userAgent,
      apartmentNumbers: known?.apartmentNumbers ?? [],
      details: { stage: 'verify', tier: locked.tier, until: locked.locked_until },
    });
    return NextResponse.json(
      {
        ok: false, locked: true, lockedUntil: locked.locked_until,
        message: portalLockedMessage(lockoutMinutesRemaining(locked)),
      },
      { status: 429 },
    );
  }

  const outcome = await verifyCode(phoneE164, body.data.code);

  // Resolved once, up front, and attached to EVERY failure event below. The
  // apartment card filters the log on apartment_numbers, so an event logged
  // without them would be invisible there — an admin would see the lockout but
  // not the four wrong codes that led to it. A phone that is not on the roster
  // resolves to [] and shows as "—" on the admin screen, which is the point of
  // logging it at all.
  const identity = await findPortalRegistration(phoneE164, { onlyActive: false });
  const apartmentNumbers = identity?.apartmentNumbers ?? [];

  if (outcome.kind === 'none' || outcome.kind === 'expired') {
    await logPortalEvent({ phoneE164, eventType: 'code_expired', apartmentNumbers, ip, userAgent });
    return NextResponse.json(
      { ok: false, expired: true, message: 'תוקף הקוד פג. שלחו קוד חדש כדי להמשיך.' },
      { status: 401 },
    );
  }

  if (outcome.kind === 'invalid') {
    await logPortalEvent({
      phoneE164, eventType: 'code_invalid', apartmentNumbers, ip, userAgent,
      details: { attempts: outcome.attempts },
    });
    if (outcome.attempts >= PORTAL_OTP_MAX_ATTEMPTS) {
      const { lockout, countInWindow } = await createLockout(phoneE164, 'too_many_invalid_codes');
      await logPortalEvent({
        phoneE164, eventType: 'locked_out', ip, userAgent, apartmentNumbers,
        details: { reason: 'too_many_invalid_codes', tier: lockout.tier, until: lockout.locked_until },
      });
      if (countInWindow >= PORTAL_LOCKOUT_ALERT_TIER) {
        await alertManagerAboutLockout(phoneE164);
      }
      return NextResponse.json(
        {
          ok: false, locked: true, attemptsLeft: 0,
          lockedUntil: lockout.locked_until,
          message: portalLockedMessage(lockoutMinutesRemaining(lockout)),
        },
        { status: 429 },
      );
    }
    // The remaining attempts come from the SERVER, never from a client-side
    // tally: the screen's "נותרו N" and its last-attempt warning then say
    // exactly what the next wrong code will really do (state 06 / 08).
    const attemptsLeft = PORTAL_OTP_MAX_ATTEMPTS - outcome.attempts;
    return NextResponse.json(
      { ok: false, attemptsLeft, message: portalWrongCodeMessage(attemptsLeft) },
      { status: 401 },
    );
  }

  // The code matched. Re-check the roster: between the request and the code being
  // typed the row may have been switched off, and a consumed code must not open a
  // session for a phone that is no longer an active owner.
  const active = await findPortalRegistration(phoneE164, { onlyActive: true });
  if (!active) {
    await logPortalEvent({ phoneE164, eventType: 'phone_inactive', apartmentNumbers, ip, userAgent });
    return NextResponse.json(
      { ok: false, notRegistered: true, message: PORTAL_NOT_OWNER_MESSAGE },
      { status: 403 },
    );
  }

  await startPortalSession({ phoneE164, ip, userAgent });
  await logPortalEvent({
    phoneE164, eventType: 'login_success',
    apartmentNumbers: active.apartmentNumbers, ip, userAgent,
  });

  return NextResponse.json({ ok: true });
}

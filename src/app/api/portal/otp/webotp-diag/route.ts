import { NextResponse } from 'next/server';
import { parseJsonBody } from '@/lib/http/body';
import { portalOtpWebotpDiagBodySchema } from '@/lib/validation/requests';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/portal/otp/webotp-diag — a fire-and-forget beacon from
// PortalOtpStep's WebOTP subscription (17/10/2026, round 2 of the OTP input
// fix: "no suggestion ever appears, not even the keyboard chip").
//
// WHY A ROUTE AND NOT A CLIENT-SIDE SENTRY BREADCRUMB: browser Sentry is OFF
// in this app — src/instrumentation-client.ts only initialises when
// SENTRY_CLIENT_DSN was inlined at BUILD time, and next.config.ts reads that
// from the BUILD environment's SENTRY_DSN, which scripts/deploy.sh / CI never
// set (by design — see the comment there). A `Sentry.addBreadcrumb` call from
// a 'use client' component would be a silent no-op, which is exactly the kind
// of invisible failure this was supposed to fix. The SERVER's Sentry, by
// contrast, reads SENTRY_DSN at runtime and is live — so this route's job is
// just to hand the browser's WebOTP lifecycle to `logger`, which already
// forwards `.error()` calls there.
//
// No PII: no phone, no code — only which lifecycle point fired and, for a
// rejection, the DOMException name. `AbortError` is the normal shape of
// leaving step 2 (unmount aborts the pending `credentials.get()`); treating
// it as a hard error would mean one Sentry event per resident who ever
// navigates away.

export async function POST(req: Request) {
  const body = await parseJsonBody(req, portalOtpWebotpDiagBodySchema);
  if (!body.ok) return body.response;

  const ip = clientIp(req);
  const limit = await checkRateLimit(`portal:webotp-diag:ip:${ip}`, { max: 30, windowSec: 60 });
  // Best-effort beacon: a throttled caller gets the same empty 200 as a
  // logged one — there is nothing for the resident's screen to react to.
  if (!limit.allowed) return NextResponse.json({ ok: true });

  const { event, reason } = body.data;
  if (event === 'start') {
    logger.info('[portal] WebOTP listen started');
  } else if (event === 'resolve') {
    logger.info('[portal] WebOTP credentials.get resolved', { reason });
  } else if (reason === 'AbortError') {
    logger.info('[portal] WebOTP credentials.get aborted (left the screen)', { reason });
  } else if (reason === 'NotAllowedError') {
    logger.warn('[portal] WebOTP credentials.get denied', { reason });
  } else {
    logger.error('[portal] WebOTP credentials.get rejected unexpectedly', { reason });
  }

  return NextResponse.json({ ok: true });
}

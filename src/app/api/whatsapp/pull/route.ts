import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { pullGreenApiMessages } from '@/lib/whatsapp-inbound';
import { resolveSendCreds, InstanceNotConfiguredError } from '@/lib/db/whatsappInstances';
import { WhatsAppError } from '@/lib/whatsapp';
import { checkRateLimit, clientIp } from '@/lib/auth/rateLimit';
import { WHATSAPP_PULL_MAX_PER_IP, AUTH_RATE_WINDOW_SEC } from '@/lib/constants';

export const runtime = 'nodejs';

// POST /api/whatsapp/pull — proactive fallback: pull the last N minutes of
// incoming messages from the acting user's instance and store the new ones.
// Gated on whatsapp:edit (it writes inbound rows). Returns { received, skipped }.
export async function POST(req: NextRequest) {
  // Throttle by IP before auth so floods can't hammer the external Green API
  // pull (which writes inbound rows). Matches the login 429 shape.
  const { allowed, retryAfterSec } = await checkRateLimit('whatsapp:pull:ip:' + clientIp(req), {
    max: WHATSAPP_PULL_MAX_PER_IP,
    windowSec: AUTH_RATE_WINDOW_SEC,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
    );
  }

  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // Optional window override; default 24h, capped at 7 days.
  let minutes = 1440;
  try {
    const body = (await req.json()) as { minutes?: unknown };
    if (typeof body?.minutes === 'number' && body.minutes > 0) {
      minutes = Math.min(Math.floor(body.minutes), 10080);
    }
  } catch {
    /* no body — use default */
  }

  try {
    const creds = await resolveSendCreds(actor, null);
    const result = await pullGreenApiMessages(creds, minutes);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}

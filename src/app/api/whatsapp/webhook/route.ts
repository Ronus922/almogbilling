import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getGreenApiWebhookToken } from '@/lib/db/greenApiSettings';
import { parseWebhookNotification } from '@/lib/whatsapp';
import { processIncomingMessage } from '@/lib/whatsapp-inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/whatsapp/webhook — PUBLIC (no session). Green API calls this for
// every inbound message. Auth is a shared bearer secret (webhook_token, stored
// in app_settings.green_api) which Green API echoes in the Authorization header.
//
// Hard rules:
//   • No valid token → 401 with NO body.
//   • Always 200 fast on accepted calls (Green API retries on errors; we don't
//     want it hammering us — log failures internally instead).
//   • Dedup is handled downstream by ON CONFLICT (external_message_id) DO NOTHING.

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expected = await getGreenApiWebhookToken();
  if (!expected) {
    // Inbound receiving isn't configured — reject silently.
    return new NextResponse(null, { status: 401 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const provided = auth.replace(/^Bearer\s+/i, '').trim();
  if (!provided || !tokenMatches(provided, expected)) {
    return new NextResponse(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // Malformed body — ack so Green API stops retrying.
    return NextResponse.json({ ok: true });
  }

  const parsed = parseWebhookNotification(payload);
  if (!parsed) {
    // Non-incoming notification (delivery status / state change / unsupported
    // message type / group chat) — acknowledge and ignore in this phase.
    return NextResponse.json({ ok: true });
  }

  try {
    await processIncomingMessage(parsed);
  } catch (err) {
    console.error('[whatsapp/webhook] processing failed', err);
  }
  return NextResponse.json({ ok: true });
}

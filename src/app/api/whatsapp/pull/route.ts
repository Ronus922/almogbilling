import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { pullGreenApiMessages } from '@/lib/whatsapp-inbound';
import { GreenApiNotConfiguredError } from '@/lib/db/greenApiSettings';
import { WhatsAppError } from '@/lib/whatsapp';

export const runtime = 'nodejs';

// POST /api/whatsapp/pull — proactive fallback: pull the last N minutes of
// incoming messages from Green API and store the new ones. Gated on whatsapp:edit
// (it writes inbound rows). Returns { received, skipped }.
export async function POST(req: NextRequest) {
  try {
    await requirePermission('whatsapp', 'edit');
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
    const result = await pullGreenApiMessages(minutes);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof GreenApiNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}

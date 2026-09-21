import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { resolveBroadcastRecipients, resolveConsolidatedBroadcastRecipients } from '@/lib/whatsapp-broadcast';
import {
  interpolateBroadcastTemplate, isDebtMessageTemplate, resolveConsolidatedName,
} from '@/lib/whatsapp-template';
import type { BroadcastAudienceType } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];

// POST /api/whatsapp/audience-count { type, body } — how many messages a
// broadcast audience + message will actually send (whatsapp_chat:view). A
// POST body — the message can be long free text, and its content decides
// the route (see below), so a query string isn't enough. `count` is the
// number of PHONES that will receive a message — identical whether `body` is
// a free-form or a debt message (both are one-message-per-phone; only the
// CONTENT differs) — never a per-apartment count. `partial_count` is how many
// of those, for a debt message, would have their apartment list truncated
// (see interpolateBroadcastTemplate); always 0 for a free-form message.
export async function POST(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let parsed: { type?: unknown; body?: unknown };
  try { parsed = await req.json(); } catch { parsed = {}; }
  const type = (TYPES as readonly string[]).includes(parsed.type as string)
    ? (parsed.type as BroadcastAudienceType)
    : 'all';
  const messageBody = typeof parsed.body === 'string' ? parsed.body : '';

  if (isDebtMessageTemplate(messageBody)) {
    const consolidated = await resolveConsolidatedBroadcastRecipients({ type });
    const partialCount = consolidated.reduce((n, r) => {
      const rendered = interpolateBroadcastTemplate(messageBody, {
        name: resolveConsolidatedName(r.rawNames),
        apartments: r.apartments,
      });
      return rendered.truncated ? n + 1 : n;
    }, 0);
    return NextResponse.json({ count: consolidated.length, partial_count: partialCount });
  }

  const recipients = await resolveBroadcastRecipients({ type });
  return NextResponse.json({ count: recipients.length, partial_count: 0 });
}

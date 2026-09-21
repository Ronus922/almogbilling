import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  resolveBroadcastRecipients, resolveConsolidatedBroadcastRecipients,
  resolveSelectionRecipients, resolveConsolidatedSelectionRecipients,
  parseBroadcastDebtFilter,
} from '@/lib/whatsapp-broadcast';
import {
  interpolateBroadcastTemplate, isDebtMessageTemplate, resolveConsolidatedName,
} from '@/lib/whatsapp-template';
import type { BroadcastAudienceType, BroadcastRoleSelection } from '@/types/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES: readonly BroadcastAudienceType[] = ['all', 'owners', 'tenants'];
const ROLE_SELECTIONS: readonly BroadcastRoleSelection[] = ['owners', 'tenants', 'suppliers'];

// POST /api/whatsapp/audience-count { type, body } or { type: 'selection',
// roles, body } — how many messages a broadcast audience + message will
// actually send (whatsapp_chat:view). A POST body — the message can be long
// free text, and its content decides the route (see below), so a query
// string isn't enough. `count` is the number of PHONES that will receive a
// message — identical whether `body` is a free-form or a debt message (both
// are one-message-per-phone; only the CONTENT differs) — never a
// per-apartment count. `partial_count` is how many of those, for a debt
// message, would have their apartment list truncated (see
// interpolateBroadcastTemplate); always 0 for a free-form message. Returns a
// 400 `error` (no count) when a debt message's audience includes suppliers —
// mirrors the campaign-creation hard block, so the compose screen can show
// the same blocking message before the operator even attempts to send.
export async function POST(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let parsed: { type?: unknown; roles?: unknown; body?: unknown; debt_filter?: unknown };
  try { parsed = await req.json(); } catch { parsed = {}; }
  const messageBody = typeof parsed.body === 'string' ? parsed.body : '';
  const isDebt = isDebtMessageTemplate(messageBody);

  if (parsed.type === 'selection') {
    const roles = Array.isArray(parsed.roles)
      ? Array.from(new Set(parsed.roles.filter((x): x is BroadcastRoleSelection => (ROLE_SELECTIONS as readonly string[]).includes(x as string))))
      : [];
    if (roles.length === 0) return NextResponse.json({ count: 0, partial_count: 0 });

    if (isDebt && roles.includes('suppliers')) {
      return NextResponse.json({
        error: 'לא ניתן לשלוח הודעת חוב (עם משתני חוב/דירה) לקהל שכולל ספקים — לספקים אין דירה או חוב. הסירו את "ספקים" מקהל היעד, או השתמשו בתבנית ללא משתני חוב.',
      }, { status: 400 });
    }

    // "רק מי שחייב" / "מעל ₪" (Section 4) — owners/tenants only.
    const debtFilter = parseBroadcastDebtFilter(parsed.debt_filter);

    if (isDebt) {
      const consolidated = await resolveConsolidatedSelectionRecipients(roles, debtFilter);
      const partialCount = consolidated.reduce((n, r) => {
        const rendered = interpolateBroadcastTemplate(messageBody, {
          name: resolveConsolidatedName(r.rawNames),
          apartments: r.apartments,
        });
        return rendered.truncated ? n + 1 : n;
      }, 0);
      return NextResponse.json({ count: consolidated.length, partial_count: partialCount });
    }

    const resolved = await resolveSelectionRecipients(roles, debtFilter);
    return NextResponse.json({ count: resolved.length, partial_count: 0 });
  }

  const type = (TYPES as readonly string[]).includes(parsed.type as string)
    ? (parsed.type as BroadcastAudienceType)
    : 'all';

  if (isDebt) {
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

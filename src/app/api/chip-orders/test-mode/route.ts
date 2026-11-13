import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { chipOrderTestModeBodySchema } from '@/lib/validation/requests';
import { writeAudit } from '@/lib/db/audit';
import { disableTestMode, getTestModeState, issueTestLink } from '@/lib/chipOrders/testMode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The test mode of /chip-order (13/11/2026) — chips_orders_manage ONLY (the
// settings form's settings:* does not reach it). GET = is it on, and since
// when the current link exists; the token itself is never readable again.
// POST { action }:
//   'enable' / 'regenerate' — a NEW link (the previous one dies) — answered
//                             once with the full link to copy;
//   'disable'               — off, the token is dropped.
// The token is never written to the audit row or to a log.

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

async function guard(action: 'view' | 'edit'): Promise<Actor | NextResponse> {
  try {
    return await requirePermission('chips_orders_manage', action);
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}

export async function GET() {
  const actor = await guard('view');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ state: await getTestModeState() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const actor = await guard('edit');
  if (actor instanceof NextResponse) return actor;
  const body = await parseJsonBody(req, chipOrderTestModeBodySchema);
  if (!body.ok) return body.response;

  if (body.data.action === 'disable') {
    const state = await disableTestMode(actor.id);
    await writeAudit({ actorUserId: actor.id, action: 'test_mode_disabled', entityType: 'chip_orders_settings' });
    return NextResponse.json({ state }, { headers: NO_STORE });
  }
  const { link, state } = await issueTestLink(actor.id);
  await writeAudit({
    actorUserId: actor.id,
    action: body.data.action === 'enable' ? 'test_mode_enabled' : 'test_mode_link_regenerated',
    entityType: 'chip_orders_settings',
  });
  return NextResponse.json({ state, link }, { headers: NO_STORE });
}

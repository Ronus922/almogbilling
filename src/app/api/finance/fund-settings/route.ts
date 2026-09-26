import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeFundSettingsBodySchema } from '@/lib/validation/requests';
import { getRenovationFundSettings, updateRenovationFundSettings } from '@/lib/db/finance/fund-settings';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/finance/fund-settings — the renovation fund collection target.
export async function GET() {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  return NextResponse.json({ settings: await getRenovationFundSettings() });
}

// PUT /api/finance/fund-settings — { target_amount } (₪, ≥ 0).
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeFundSettingsBodySchema);
  if (!body.ok) return body.response;

  const before = await getRenovationFundSettings();
  const settings = await updateRenovationFundSettings(body.data, actor.id);
  await writeAudit({
    actorUserId: actor.id, action: 'updated', entityType: 'renovation_fund_settings',
    changes: { before: { target_amount: before.target_amount }, after: { target_amount: settings.target_amount } },
  });
  return NextResponse.json({ settings });
}

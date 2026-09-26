import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeSettingsBodySchema } from '@/lib/validation/requests';
import { getFinanceSettings, updateFinanceSettings } from '@/lib/db/finance/settings';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/finance/settings — the module's single settings row.
export async function GET() {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  return NextResponse.json({ settings: await getFinanceSettings() });
}

// PUT /api/finance/settings — persists the "show documents to residents"
// switch. Nothing enforces it in slice A: the owners portal will read it.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeSettingsBodySchema);
  if (!body.ok) return body.response;

  const settings = await updateFinanceSettings(body.data, actor.id);
  await writeAudit({ actorUserId: actor.id, action: 'updated', entityType: 'fin_settings', changes: { after: body.data } });
  return NextResponse.json({ settings });
}

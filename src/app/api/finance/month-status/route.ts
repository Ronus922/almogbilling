import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeMonthStatusBodySchema } from '@/lib/validation/requests';
import { setMonthPublished } from '@/lib/db/finance/month-status';
import { monthKeyParts } from '@/lib/finance/period';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUT /api/finance/month-status — { month: 'YYYY-MM', published } shows or
// hides one month for residents. Saved at once; published_at / published_by
// record this toggle. Editing a published month stays allowed — the overview
// only warns that residents see the change immediately.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeMonthStatusBodySchema);
  if (!body.ok) return body.response;

  const { year, month } = monthKeyParts(body.data.month);
  const status = await setMonthPublished(year, month, body.data.published, actor.id);
  await writeAudit({
    actorUserId: actor.id,
    action: body.data.published ? 'published' : 'unpublished',
    entityType: 'fin_month',
    metadata: { month: body.data.month },
  });
  return NextResponse.json({ status });
}

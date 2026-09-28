import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeMonthStatusBodySchema } from '@/lib/validation/requests';
import { setMonthBankBalance, setMonthPublished } from '@/lib/db/finance/month-status';
import { monthKeyParts } from '@/lib/finance/period';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUT /api/finance/month-status — { month: 'YYYY-MM', published?, bank_balance? }
// shows or hides one month for residents and/or sets its hand-entered
// month-end bank balance (null clears it). Saved at once; published_at /
// published_by record the toggle, bank_balance_updated_* the balance. Editing a
// published month stays allowed — the overview only warns that residents see
// the change immediately.
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeMonthStatusBodySchema);
  if (!body.ok) return body.response;

  const { year, month } = monthKeyParts(body.data.month);
  let status = null;
  if (body.data.published !== undefined) {
    status = await setMonthPublished(year, month, body.data.published, actor.id);
    await writeAudit({
      actorUserId: actor.id,
      action: body.data.published ? 'published' : 'unpublished',
      entityType: 'fin_month',
      metadata: { month: body.data.month },
    });
  }
  if (body.data.bank_balance !== undefined) {
    status = await setMonthBankBalance(year, month, body.data.bank_balance, actor.id);
    await writeAudit({
      actorUserId: actor.id,
      action: 'bank_balance_set',
      entityType: 'fin_month',
      metadata: { month: body.data.month, bank_balance: body.data.bank_balance },
    });
  }
  return NextResponse.json({ status });
}

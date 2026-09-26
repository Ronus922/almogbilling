import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeCategoryOrderSchema } from '@/lib/validation/requests';
import { reorderCategories } from '@/lib/db/finance/categories';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUT /api/finance/categories/order — { ids } in the wanted order (one kind).
export async function PUT(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeCategoryOrderSchema);
  if (!body.ok) return body.response;

  await reorderCategories(body.data.ids);
  await writeAudit({ actorUserId: actor.id, action: 'reordered', entityType: 'fin_category', metadata: { count: body.data.ids.length } });
  return NextResponse.json({ ok: true });
}

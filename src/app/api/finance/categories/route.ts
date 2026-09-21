import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeCategoryBodySchema } from '@/lib/validation/requests';
import { createCategory, listCategories, FinanceConflictError } from '@/lib/db/finance/categories';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/finance/categories?all=1 — the categories (active only by default).
export async function GET(req: NextRequest) {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const includeInactive = req.nextUrl.searchParams.get('all') === '1';
  return NextResponse.json({ categories: await listCategories({ includeInactive }) });
}

// POST /api/finance/categories — new category, appended to the end of its kind.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const body = await parseJsonBody(req, financeCategoryBodySchema);
  if (!body.ok) return body.response;

  try {
    const category = await createCategory(body.data, actor.id);
    await writeAudit({ actorUserId: actor.id, action: 'created', entityType: 'fin_category', entityId: category.id, metadata: { kind: category.kind, name: category.name } });
    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    if (err instanceof FinanceConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

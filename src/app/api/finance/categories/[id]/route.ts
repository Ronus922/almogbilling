import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeCategoryPatchSchema } from '@/lib/validation/requests';
import { deleteCategory, updateCategory, FinanceConflictError } from '@/lib/db/finance/categories';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/finance/categories/[id] — rename / flags / active. kind is immutable.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'הסעיף לא נמצא' }, { status: 404 });

  const body = await parseJsonBody(req, financeCategoryPatchSchema);
  if (!body.ok) return body.response;

  try {
    const category = await updateCategory(id, body.data);
    if (!category) return NextResponse.json({ error: 'הסעיף לא נמצא' }, { status: 404 });
    await writeAudit({ actorUserId: actor.id, action: 'updated', entityType: 'fin_category', entityId: id, changes: { after: body.data } });
    return NextResponse.json({ category });
  } catch (err) {
    if (err instanceof FinanceConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}

// DELETE /api/finance/categories/[id] — only a category with NO entries (even
// soft-deleted ones) can go; otherwise 409 and the UI offers "השבת".
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'הסעיף לא נמצא' }, { status: 404 });

  const result = await deleteCategory(id);
  if (result === 'not_found') return NextResponse.json({ error: 'הסעיף לא נמצא' }, { status: 404 });
  if (result === 'has_entries') {
    return NextResponse.json({ error: 'לסעיף יש שורות — ניתן להשבית אותו, לא למחוק' }, { status: 409 });
  }
  await writeAudit({ actorUserId: actor.id, action: 'deleted', entityType: 'fin_category', entityId: id });
  return NextResponse.json({ ok: true });
}

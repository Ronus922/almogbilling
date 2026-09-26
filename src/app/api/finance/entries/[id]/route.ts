import { NextResponse, type NextRequest, after } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { financeEntryBodySchema } from '@/lib/validation/requests';
import { getEntry, softDeleteEntry, updateEntry } from '@/lib/db/finance/entries';
import { linkDocuments } from '@/lib/db/finance/documents';
import { resolveEntryInput } from '@/lib/finance/entry-input';
import { syncDocumentsInBackground } from '@/lib/finance/drive-sync';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/finance/entries/[id]
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try { await requirePermission('finance', 'view'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  const entry = await getEntry(id);
  if (!entry) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  return NextResponse.json({ entry });
}

// PATCH /api/finance/entries/[id] — full update (the sheet always sends every
// field). kind and section (operating / fund) cannot change; new staged documents are linked on top of the
// existing ones (removal goes through DELETE /api/finance/documents/[docId]).
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  const existing = await getEntry(id);
  if (!existing) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });

  const body = await parseJsonBody(req, financeEntryBodySchema);
  if (!body.ok) return body.response;
  if (body.data.kind !== existing.kind) return NextResponse.json({ error: 'לא ניתן לשנות את סוג השורה' }, { status: 400 });
  if (body.data.section !== existing.category_section) {
    return NextResponse.json({ error: 'לא ניתן להעביר שורה בין התקציב השוטף לקרן השיפוצים' }, { status: 400 });
  }
  if (existing.documents.length + body.data.document_ids.length > 5) {
    return NextResponse.json({ error: 'ניתן לצרף עד 5 קבצים' }, { status: 400 });
  }

  const resolved = await resolveEntryInput(body.data, 'update');
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const updated = await updateEntry(id, resolved.input, actor.id);
  if (!updated) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  const linked = await linkDocuments(id, body.data.document_ids, actor.id);
  await writeAudit({
    actorUserId: actor.id, action: 'updated', entityType: 'fin_entry', entityId: id,
    changes: { before: { amount: existing.amount, category_id: existing.category_id, period_month: existing.period_month },
               after:  { amount: updated.amount,  category_id: updated.category_id,  period_month: updated.period_month } },
    metadata: { documents_linked: linked },
  });
  if (linked > 0) after(() => syncDocumentsInBackground(body.data.document_ids));

  const entry = linked > 0 ? await getEntry(id) : updated;
  return NextResponse.json({ entry, documents_linked: linked, documents_requested: body.data.document_ids.length });
}

// DELETE /api/finance/entries/[id] — soft delete (deleted_at / deleted_by).
// The documents and their Drive copies stay with the deleted row.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  const ok = await softDeleteEntry(id, actor.id);
  if (!ok) return NextResponse.json({ error: 'השורה לא נמצאה' }, { status: 404 });
  await writeAudit({ actorUserId: actor.id, action: 'deleted', entityType: 'fin_entry', entityId: id });
  return NextResponse.json({ ok: true });
}

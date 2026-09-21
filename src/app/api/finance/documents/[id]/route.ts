import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { deleteEntryDocument, deleteStagedDocument, getDocument } from '@/lib/db/finance/documents';
import { removeFinanceReceipt } from '@/lib/storage/financeReceiptStorage';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/finance/documents/[id] — remove a receipt: either one the actor
// staged and took out of the sheet again, or one already linked to an entry
// (the edit sheet's X). The Storage object goes with the row; a Drive copy, if
// one was made, is left in place as the backup.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });

  let row = await deleteStagedDocument(id, actor.id);
  if (!row) {
    const doc = await getDocument(id);
    if (doc?.entry_id) row = await deleteEntryDocument(id, doc.entry_id);
  }
  if (!row) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });

  await removeFinanceReceipt(row.object_key);
  if (row.entry_id) {
    await writeAudit({ actorUserId: actor.id, action: 'document_removed', entityType: 'fin_entry', entityId: row.entry_id, metadata: { document_id: id, name: row.original_name } });
  }
  return NextResponse.json({ ok: true });
}

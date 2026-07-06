import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDocumentById, hardDeleteDocument } from '@/lib/db/documents';
import { removeDocumentFile } from '@/lib/storage/documentStorage';
import { UUID_RE } from '@/lib/validation/documents';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string; docId: string }>;
}

// DELETE /api/debtors/[id]/documents/[docId]  (contacts:edit) — hard delete from
// Storage + DB. Scoped: the document must be attached to THIS debtor.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id, docId } = await ctx.params;
  if (!UUID_RE.test(docId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const doc = await getDocumentById(docId);
  if (!doc || doc.entity_type !== 'debtor' || doc.entity_id !== id) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  await removeDocumentFile(doc.storage_path); // best-effort; the row is authoritative
  const ok = await hardDeleteDocument(docId);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'document',
    entityId: docId,
    changes: { before: doc },
    metadata: { debtor_id: id },
  });

  return new NextResponse(null, { status: 204 });
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getSupplierDocument,
  deleteSupplierDocumentRow,
  renameSupplierDocument,
} from '@/lib/db/suppliers';
import { removeSupplierFile, fileUrlForPath } from '@/lib/storage/supplierStorage';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string; docId: string }>;
}

// GET /api/suppliers/[id]/documents/[docId] (view) — fresh signed URL for viewing.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { docId } = await ctx.params;
  const doc = await getSupplierDocument(docId);
  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const signed_url = fileUrlForPath(doc.file_url);
  if (!signed_url) {
    return NextResponse.json({ error: 'signed_url_unavailable' }, { status: 502 });
  }
  return NextResponse.json({ signed_url });
}

// PATCH /api/suppliers/[id]/documents/[docId] (suppliers:edit) — rename only.
// Edits the display name (file_name); the stored object path is immutable.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id, docId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const fileName = String((body as Record<string, unknown>)?.file_name ?? '').trim();
  if (!fileName) {
    return NextResponse.json({ error: 'file_name_required' }, { status: 400 });
  }

  const doc = await getSupplierDocument(docId);
  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const updated = await renameSupplierDocument(docId, fileName.slice(0, 200));
    if (!updated) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (doc.file_name !== updated.file_name) {
      await writeAudit({
        actorUserId: actor.id,
        action: 'document_renamed',
        entityType: 'supplier',
        entityId: id,
        metadata: { document_id: docId, from: doc.file_name, to: updated.file_name },
      });
    }
    const signed_url = fileUrlForPath(updated.file_url);
    return NextResponse.json({ document: { ...updated, signed_url } });
  } catch (err) {
    logger.error('[PATCH /api/suppliers/:id/documents/:docId]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/suppliers/[id]/documents/[docId] (suppliers:edit) — physical delete.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id, docId } = await ctx.params;

  const doc = await getSupplierDocument(docId);
  if (!doc) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    await removeSupplierFile(doc.file_url);
    await deleteSupplierDocumentRow(docId);
    await writeAudit({
      actorUserId: actor.id,
      action: 'document_deleted',
      entityType: 'supplier',
      entityId: id,
      metadata: { document_id: docId, file_name: doc.file_name },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[DELETE /api/suppliers/:id/documents/:docId]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

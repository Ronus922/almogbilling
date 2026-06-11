import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getSupplierDocument, deleteSupplierDocumentRow } from '@/lib/db/suppliers';
import { removeSupplierFile, signedUrlForPath } from '@/lib/storage/supplierStorage';

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

  const signed_url = await signedUrlForPath(doc.file_url);
  if (!signed_url) {
    return NextResponse.json({ error: 'signed_url_unavailable' }, { status: 502 });
  }
  return NextResponse.json({ signed_url });
}

// DELETE /api/suppliers/[id]/documents/[docId] (admin) — physical delete.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin();
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

  try {
    await removeSupplierFile(doc.file_url);
    await deleteSupplierDocumentRow(docId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/suppliers/:id/documents/:docId]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

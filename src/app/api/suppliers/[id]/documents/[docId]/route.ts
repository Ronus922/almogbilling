import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getSupplierDocument, deleteSupplierDocumentRow } from '@/lib/db/suppliers';
import { removeSupplierFile } from '@/lib/storage/supplierStorage';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string; docId: string }>;
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

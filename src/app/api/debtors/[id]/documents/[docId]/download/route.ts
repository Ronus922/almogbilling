import { NextResponse, type NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDocumentById } from '@/lib/db/documents';
import { signedUrlForPath } from '@/lib/storage/documentStorage';
import { UUID_RE } from '@/lib/validation/documents';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string; docId: string }>;
}

// GET /api/debtors/[id]/documents/[docId]/download — permission-checks, then
// redirects to a short-lived signed URL whose Content-Disposition carries the
// readable (Hebrew) file name, so the browser downloads it under that name.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requireAnyPermission([
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]);
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

  const url = await signedUrlForPath(doc.storage_path, doc.file_name);
  if (!url) return NextResponse.json({ error: 'file_unavailable' }, { status: 502 });

  return NextResponse.redirect(url);
}

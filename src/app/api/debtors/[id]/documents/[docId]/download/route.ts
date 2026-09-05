import { NextResponse, type NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDocumentById } from '@/lib/db/documents';
import { downloadDocumentFile, extOf } from '@/lib/storage/documentStorage';
import { UUID_RE } from '@/lib/validation/documents';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string; docId: string }>;
}

/** RFC 5987: ASCII fallback + UTF-8 form so a Hebrew filename survives. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'document';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET /api/debtors/[id]/documents/[docId]/download — permission-checks, then
// STREAMS the file under its readable (Hebrew) name. It used to redirect to a
// signed URL, which handed the caller a permission-free bearer link to the
// storage host; the bytes now never leave the app origin.
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

  let blob: Blob | null;
  try {
    blob = await downloadDocumentFile(doc.storage_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[GET /api/debtors/:id/documents/:docId/download] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    logger.error('[GET /api/debtors/:id/documents/:docId/download] download failed', err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return NextResponse.json({ error: 'file_unavailable' }, { status: 502 });

  // Keep the real extension even if the user renamed the document ("דוח" → "דוח.pdf").
  const base = (doc.file_name || '').trim() || 'document';
  const ext = extOf(doc.storage_path);
  const filename = !ext || base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': doc.mime_type || 'application/octet-stream',
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(blob.size),
      'Cache-Control': 'private, no-store',
    },
  });
}

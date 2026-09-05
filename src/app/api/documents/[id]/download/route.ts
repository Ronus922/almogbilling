import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDocumentById } from '@/lib/db/documents';
import { downloadDocumentFile, extOf } from '@/lib/storage/documentStorage';
import { UUID_RE } from '@/lib/validation/documents';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * The filename the user should get on download: the readable documents.file_name,
 * guaranteed to carry the file's real extension. The extension is taken from the
 * (authoritative) ASCII storage key (e.g. `<uuid>.pdf`) and appended if file_name
 * lacks it — so a user who renamed "דוח.pdf" → "דוח שנתי" still downloads a .pdf.
 */
function downloadName(fileName: string, storagePath: string): string {
  const base = (fileName || '').trim() || 'document';
  const ext = extOf(storagePath);
  if (!ext) return base;
  return base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;
}

/**
 * Content-Disposition with RFC 5987 encoding so a Hebrew (UTF-8) filename is not
 * mangled: an ASCII `filename="..."` fallback for legacy clients PLUS
 * `filename*=UTF-8''<pct-encoded>` which modern browsers prefer.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'document';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// GET /api/documents/[id]/download  (documents:view) — streams the file with the
// readable (Hebrew) filename + extension and the stored mime type.
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('documents', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const doc = await getDocumentById(id);
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let blob: Blob | null;
  try {
    blob = await downloadDocumentFile(doc.storage_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[GET /api/documents/:id/download] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    logger.error('[GET /api/documents/:id/download] download failed', err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return NextResponse.json({ error: 'file_unavailable' }, { status: 502 });

  const filename = downloadName(doc.file_name, doc.storage_path);
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

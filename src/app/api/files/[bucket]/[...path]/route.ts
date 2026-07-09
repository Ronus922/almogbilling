import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { queryOne } from '@/lib/db';
import { getObjectStream, PRIVATE_BUCKETS, type PrivateBucket } from '@/lib/storage/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ bucket: string; path: string[] }>;
}

/**
 * Authenticated file proxy — the ONLY way a stored object reaches a browser.
 * Replaces the old signed URLs, which were bearer tokens: anyone holding the link
 * opened the file with no session and no permission check.
 *
 * Every request re-checks the session and the bucket's module permission, so
 * revoking a permission takes effect immediately instead of one signed-URL TTL later.
 */

/** Per-bucket authorization. A bucket missing from this map is not servable. */
const BUCKET_GUARD: Record<PrivateBucket, () => Promise<unknown>> = {
  'supplier-documents': () => requirePermission('suppliers', 'view'),
  'issue-attachments': () => requirePermission('issues', 'view'),
  // The `documents` bucket backs two modules: the documents browser AND debtor
  // documents (reachable with dashboard:view / contacts:view). Mirror the union
  // the existing routes already grant — still far tighter than a signed URL,
  // which granted access to anyone at all.
  documents: () =>
    requireAnyPermission([
      { module: 'documents', action: 'view' },
      { module: 'dashboard', action: 'view' },
      { module: 'contacts', action: 'view' },
    ]),
};

/**
 * Object keys are machine-built and ASCII (see lib/storage/objectKey.ts).
 * Anything else — traversal, absolute paths, encoded dots — is rejected before it
 * can reach Storage. SEGMENT_RE is what actually blocks traversal: no slashes, no
 * bare dots.
 *
 * The leaf must OPEN with a random UUID, which both formats in the DB satisfy:
 *   current: `<uuid>.pdf`
 *   legacy:  `<uuid>-2022-09-24_13.08.58.jpg`  (supplier-documents)
 * Requiring a full-string `<uuid>.<ext>` would 404 every legacy supplier document.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LEAF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.-][A-Za-z0-9._-]*)?$/i;

function isSafePath(segments: string[]): boolean {
  if (segments.length === 0 || segments.length > 3) return false;
  if (segments.some((s) => !SEGMENT_RE.test(s) || s === '.' || s === '..')) return false;
  return LEAF_RE.test(segments[segments.length - 1]);
}

/** The readable (Hebrew) name from the owning table, when the bucket has one. */
async function lookupFileName(bucket: PrivateBucket, path: string): Promise<string | null> {
  if (bucket === 'documents') {
    const row = await queryOne<{ file_name: string }>(
      `select file_name from public.documents where storage_path = $1 limit 1`,
      [path],
    );
    return row?.file_name ?? null;
  }
  if (bucket === 'supplier-documents') {
    const row = await queryOne<{ file_name: string }>(
      `select file_name from public.supplier_documents where file_url = $1 limit 1`,
      [path],
    );
    return row?.file_name ?? null;
  }
  return null; // issue-attachments stores bare paths, no display name
}

/** RFC 5987: ASCII fallback + UTF-8 form so a Hebrew name survives. */
function contentDisposition(name: string | null): string {
  if (!name) return 'inline';
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const { bucket, path } = await ctx.params;

  // Unknown bucket → 404, never 403: don't confirm what buckets exist.
  if (!(PRIVATE_BUCKETS as readonly string[]).includes(bucket)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const known = bucket as PrivateBucket;

  try {
    await BUCKET_GUARD[known]();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const segments = path.map((s) => decodeURIComponent(s));
  if (!isSafePath(segments)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const objectPath = segments.join('/');

  let blob: Blob | null;
  try {
    blob = await getObjectStream(known, objectPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      console.error('[GET /api/files] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    console.error(`[GET /api/files/${bucket}] download failed`, err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'Content-Disposition': contentDisposition(await lookupFileName(known, objectPath)),
      'Content-Length': String(blob.size),
      'Cache-Control': 'private, no-store',
    },
  });
}

import { NextResponse, type NextRequest } from 'next/server';
import { getObjectStream, WHATSAPP_MEDIA_BUCKET } from '@/lib/storage/server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ path: string[] }>;
}

/**
 * PUBLIC, UNAUTHENTICATED media route — deliberately so.
 *
 * Green API's servers fetch outbound attachments over plain HTTP with no session
 * of ours, so this route cannot require one. It exists to keep the storage host
 * out of the URL we hand to Green API and, through it, to the WhatsApp recipient.
 * The bytes were already world-readable: the whatsapp-media bucket is public.
 * This changes WHO the URL points at, not who can read it.
 *
 * What keeps it safe: the bucket is hardcoded (never taken from the path), and an
 * object key must open with a random UUID — unguessable, so the route cannot be
 * walked. It serves outbound WhatsApp attachments and nothing else.
 */

const BUCKET = WHATSAPP_MEDIA_BUCKET;

/** Same shape rules as /api/files: ASCII segments, leaf opens with a UUID. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const LEAF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([.-][A-Za-z0-9._-]*)?$/i;

function isSafePath(segments: string[]): boolean {
  // Keys are flat here: `<uuid><.ext>` (buildObjectKey with no prefix).
  if (segments.length !== 1) return false;
  const [leaf] = segments;
  if (!SEGMENT_RE.test(leaf) || leaf === '.' || leaf === '..') return false;
  return LEAF_RE.test(leaf);
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  const segments = path.map((s) => decodeURIComponent(s));
  if (!isSafePath(segments)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let blob: Blob | null;
  try {
    blob = await getObjectStream(BUCKET, segments[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[GET /api/public/wa-media] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    logger.error('[GET /api/public/wa-media] download failed', err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'Content-Length': String(blob.size),
      // Objects are immutable (uuid key, never overwritten), so caching is free.
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

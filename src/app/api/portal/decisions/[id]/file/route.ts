import { NextResponse, type NextRequest } from 'next/server';
import { AuthorizationError } from '@/lib/auth/errors';
import { requirePortalFinanceAccess } from '@/lib/portal/session';
import { findPublishedDecision } from '@/lib/db/portalDecisions';
import { getObjectStream, PORTAL_DECISIONS_BUCKET } from '@/lib/storage/server';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/** RFC 5987: ASCII fallback + UTF-8 form so a Hebrew name survives. */
function contentDisposition(name: string, download: boolean): string {
  const kind = download ? 'attachment' : 'inline';
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'decision.pdf';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/portal/decisions/[id]/file — the PDF itself, streamed server-side
 * from the private bucket. `?download=1` sends it as an attachment under the
 * original (Hebrew) filename; without it the browser opens it in a tab.
 *
 * This is the owners' ONLY path to the bytes, and it is not a URL that can be
 * passed around: there is no signed link anywhere in the flow, the object key
 * never reaches the client, and every request re-checks the session.
 *
 * ONE response for every refusal — 404, never 401/403 and never a different
 * body — so the route confirms nothing about which documents exist:
 *   • no portal session, or a blocked phone  → 404
 *   • no such id                             → 404
 *   • the row exists but is NOT published    → 404  (findPublishedDecision
 *     carries the predicate in its SQL, so unpublishing closes this path in
 *     the same instant it closes the list)
 * A 502 is kept apart deliberately: it means the row was readable and Storage
 * failed, which is an outage to see in the log, not an access decision.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    await requirePortalFinanceAccess();
  } catch (err) {
    // Every refusal of the guard — no session, an expired one, a phone that is
    // no longer an active owner, a blocked phone — collapses into the same 404.
    if (err instanceof AuthorizationError) return notFound();
    throw err;
  }

  const { id } = await ctx.params;
  const row = await findPublishedDecision(id);
  if (!row) return notFound();

  let blob: Blob | null;
  try {
    blob = await getObjectStream(PORTAL_DECISIONS_BUCKET, row.object_key);
  } catch (err) {
    logger.error(`[GET /api/portal/decisions/${id}/file] download failed`, err);
    return NextResponse.json({ error: 'download_failed' }, { status: 502 });
  }
  if (!blob) return notFound();

  const download = req.nextUrl.searchParams.get('download') === '1';
  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'application/pdf',
      'Content-Disposition': contentDisposition(row.original_filename, download),
      'Content-Length': String(blob.size),
      'Cache-Control': 'private, no-store',
    },
  });
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { parseJsonBody } from '@/lib/http/body';
import { decisionUpdateBodySchema } from '@/lib/validation/requests';
import { deleteDecision, updateDecision } from '@/lib/db/portalDecisions';
import { removeDecisionFile } from '@/lib/storage/decisionStorage';
import { toDecisionAdminView } from '@/lib/decisionsView';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/decisions/[id] — the metadata, and the list's "מוצג בפורטל"
 * switch. The file is NEVER replaced here: replacing a document means deleting
 * it and uploading again, so no path in this route touches Storage.
 *
 * Turning `published` off takes effect immediately and everywhere — the portal
 * list and the portal file route both read the flag in their own SQL, so the
 * document disappears and its file path 404s in the same instant.
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('portal_decisions', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const body = await parseJsonBody(req, decisionUpdateBodySchema);
  if (!body.ok) return body.response;
  const d = body.data;

  const row = await updateDecision(id, {
    title: d.title,
    summary: d.summary ?? null,
    docType: d.doc_type,
    // A number belongs to a decision only — switching a row to "פרוטוקול"
    // drops it rather than keeping a value the screens would never show.
    decisionNumber: d.doc_type === 'decision' ? (d.decision_number ?? null) : null,
    decidedAt: d.decided_at,
    published: d.published,
  });
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(toDecisionAdminView(row));
}

/**
 * DELETE /api/decisions/[id] — removes the row AND the object. The row goes
 * first: it is what both screens read, so once it is gone the document is
 * unreachable even if the Storage call then fails (the object would be a
 * zombie the GC collects, never a document someone can still open).
 */
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('portal_decisions', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const row = await deleteDecision(id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    await removeDecisionFile(row.object_key);
  } catch (err) {
    logger.error(`[DELETE /api/decisions/${id}] object removal failed`, err);
  }
  return NextResponse.json({ ok: true });
}

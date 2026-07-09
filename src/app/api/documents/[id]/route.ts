import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getDocumentById,
  updateDocument,
  softDeleteDocument,
  folderExistsActive,
} from '@/lib/db/documents';
import { fileUrlForPath } from '@/lib/storage/documentStorage';
import { coerceDocumentInput, UUID_RE } from '@/lib/validation/documents';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/documents/[id]  (documents:view) — metadata + a fresh signed URL.
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

  const document = await getDocumentById(id);
  if (!document) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const signed_url = fileUrlForPath(document.storage_path);
  return NextResponse.json({ document: { ...document, signed_url } });
}

// PATCH /api/documents/[id]  (documents:edit) — rename / move / re-tag / archive / restore.
// The file bytes are immutable; only metadata is editable.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('documents', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceDocumentInput(bodyRec, 'update');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const patch: Record<string, unknown> = { ...result.fields };

  // is_archived passthrough (restore / re-archive).
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  // Move target must exist & be active (null = unfiled, allowed).
  if (Object.prototype.hasOwnProperty.call(result.fields, 'folder_id')) {
    const folderId = result.fields.folder_id ?? null;
    if (folderId !== null && !(await folderExistsActive(folderId))) {
      return NextResponse.json({ error: 'folder_not_found' }, { status: 400 });
    }
  }

  try {
    const before = await getDocumentById(id);
    if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const document = await updateDocument(id, patch);
    if (!document) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await writeAudit({
      actorUserId: actor.id,
      action: 'updated',
      entityType: 'document',
      entityId: id,
      changes: { before, after: document },
    });

    return NextResponse.json({ document });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    console.error('[PATCH /api/documents/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/documents/[id] — soft-delete (is_archived=true)  (documents:edit).
// File bytes are retained in storage; the row is archived, not removed.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('documents', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const before = await getDocumentById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ok = await softDeleteDocument(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'document',
    entityId: id,
    changes: { before },
  });

  return new NextResponse(null, { status: 204 });
}

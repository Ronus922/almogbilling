import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getDocumentFolderById,
  updateDocumentFolder,
  softDeleteDocumentFolder,
  folderExistsActive,
  isFolderInSubtree,
} from '@/lib/db/documents';
import { coerceFolderInput, UUID_RE } from '@/lib/validation/documents';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/documents/folders/[id]  (documents:view)
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

  const folder = await getDocumentFolderById(id);
  if (!folder) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ folder });
}

// PATCH /api/documents/folders/[id]  (documents:edit) — rename / move / archive / restore.
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

  const result = coerceFolderInput(bodyRec, 'update');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const patch: Record<string, unknown> = { ...result.fields };

  // is_archived passthrough (restore / re-archive).
  if (Object.prototype.hasOwnProperty.call(bodyRec, 'is_archived')) {
    if (typeof bodyRec.is_archived !== 'boolean') {
      return NextResponse.json({ error: 'invalid_boolean' }, { status: 400 });
    }
    patch.is_archived = bodyRec.is_archived;
  }

  // Move validation: cannot parent to self or to a descendant (would create a cycle).
  if (Object.prototype.hasOwnProperty.call(result.fields, 'parent_folder_id')) {
    const parentId = result.fields.parent_folder_id ?? null;
    if (parentId !== null) {
      if (parentId === id) return NextResponse.json({ error: 'invalid_parent_folder_id' }, { status: 400 });
      if (!(await folderExistsActive(parentId))) {
        return NextResponse.json({ error: 'parent_not_found' }, { status: 400 });
      }
      if (await isFolderInSubtree(parentId, id)) {
        return NextResponse.json({ error: 'folder_cycle' }, { status: 400 });
      }
    }
  }

  try {
    const before = await getDocumentFolderById(id);
    if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const folder = await updateDocumentFolder(id, patch);
    if (!folder) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await writeAudit({
      actorUserId: actor.id,
      action: 'updated',
      entityType: 'document_folder',
      entityId: id,
      changes: { before, after: folder },
    });

    return NextResponse.json({ folder });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    logger.error('[PATCH /api/documents/folders/[id]]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

// DELETE /api/documents/folders/[id] — soft-delete (is_archived=true)  (documents:edit)
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

  const before = await getDocumentFolderById(id);
  if (!before) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const ok = await softDeleteDocumentFolder(id);
  if (!ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'document_folder',
    entityId: id,
    changes: { before },
  });

  return new NextResponse(null, { status: 204 });
}

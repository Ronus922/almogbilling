import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  listDocumentFolders,
  createDocumentFolder,
  folderExistsActive,
} from '@/lib/db/documents';
import { coerceFolderInput, UUID_RE } from '@/lib/validation/documents';
import { writeAudit } from '@/lib/db/audit';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// GET /api/documents/folders?parentId=<uuid|root>&includeArchived=1  (documents:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('documents', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const parentRaw = sp.get('parentId')?.trim();
  let parentFolderId: string | null | undefined;
  if (parentRaw === 'root' || parentRaw === 'null') parentFolderId = null;
  else if (parentRaw && UUID_RE.test(parentRaw)) parentFolderId = parentRaw;
  else parentFolderId = undefined; // all

  const folders = await listDocumentFolders({
    parentFolderId,
    includeArchived: sp.get('includeArchived') === '1',
  });
  return NextResponse.json({ folders });
}

// POST /api/documents/folders  (documents:edit)
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('documents', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const bodyRec = (body ?? {}) as Record<string, unknown>;

  const result = coerceFolderInput(bodyRec, 'create');
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const parentId = result.fields.parent_folder_id ?? null;
  if (parentId && !(await folderExistsActive(parentId))) {
    return NextResponse.json({ error: 'parent_not_found' }, { status: 400 });
  }

  try {
    const folder = await createDocumentFolder(
      { name: result.fields.name as string, parent_folder_id: parentId },
      actor.id,
    );

    await writeAudit({
      actorUserId: actor.id,
      action: 'created',
      entityType: 'document_folder',
      entityId: folder.id,
      changes: { after: folder },
    });

    return NextResponse.json({ folder }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    logger.error('[POST /api/documents/folders]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

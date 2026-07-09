import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listDocuments, insertDocument, folderExistsActive } from '@/lib/db/documents';
import {
  uploadDocumentFile,
  fileUrlForPath,
} from '@/lib/storage/documentStorage';
import { ALLOWED_DOC_TYPES, MAX_DOC_SIZE_BYTES, MAX_FILE_NAME_LEN } from '@/lib/constants/documents';
import { UUID_RE } from '@/lib/validation/documents';
import { writeAudit } from '@/lib/db/audit';
import type { DocumentWithSignedUrl } from '@/lib/types/documents';

export const runtime = 'nodejs';

// GET /api/documents?folderId=<uuid|unfiled>&entityType&entityId&includeArchived=1  (documents:view)
export async function GET(req: NextRequest) {
  try {
    await requirePermission('documents', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;

  const folderRaw = sp.get('folderId')?.trim();
  let folderId: string | null | undefined;
  if (folderRaw === 'unfiled' || folderRaw === 'null') folderId = null;
  else if (folderRaw && UUID_RE.test(folderRaw)) folderId = folderRaw;
  else folderId = undefined; // all

  const documents = await listDocuments({
    folderId,
    entityType: sp.get('entityType')?.trim() || undefined,
    entityId: sp.get('entityId')?.trim() || undefined,
    includeArchived: sp.get('includeArchived') === '1',
  });

  // Attach a fresh signed URL per row (private bucket) — mirrors the suppliers
  // documents endpoint. fileUrlForPath is a pure relative-URL builder.
  const withUrls: DocumentWithSignedUrl[] = await Promise.all(
    documents.map(async (d) => ({
      ...d,
      signed_url: fileUrlForPath(d.storage_path),
    })),
  );

  return NextResponse.json({ documents: withUrls });
}

// POST /api/documents  (documents:edit) — multipart upload.
// Fields: file (required), file_name? (readable display name; defaults to the
// uploaded file's name), folder_id?, entity_type?, entity_id?
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('documents', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!ALLOWED_DOC_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }
  if (file.size > MAX_DOC_SIZE_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }

  // Optional metadata.
  const folderRaw = (form.get('folder_id') as string | null)?.trim() || null;
  if (folderRaw && !UUID_RE.test(folderRaw)) {
    return NextResponse.json({ error: 'invalid_folder_id' }, { status: 400 });
  }
  if (folderRaw && !(await folderExistsActive(folderRaw))) {
    return NextResponse.json({ error: 'folder_not_found' }, { status: 400 });
  }
  const entityType = (form.get('entity_type') as string | null)?.trim() || null;
  const entityId = (form.get('entity_id') as string | null)?.trim() || null;

  // Readable display name (separate from the ASCII storage key). The user may
  // edit it before upload; default to the original file name. Clamped to the
  // column limit so an oversized name can never reject the row.
  const customName = (form.get('file_name') as string | null)?.trim();
  const displayName = (customName || file.name).slice(0, MAX_FILE_NAME_LEN);

  let upload: { path: string; sizeBytes: number; mimeType: string };
  try {
    upload = await uploadDocumentFile(file, {
      entityType,
      entityId,
      folderId: folderRaw,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // SERVICE_ROLE_KEY / storage URL missing — surface a clear, non-silent error.
    if (msg.includes('supabase_storage_not_configured')) {
      console.error('[POST /api/documents] storage not configured (SUPABASE_SERVICE_ROLE_KEY missing)');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    console.error('[POST /api/documents] upload failed', err);
    return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
  }

  try {
    const document = await insertDocument({
      fileName: displayName,
      storagePath: upload.path,
      mimeType: upload.mimeType || null,
      sizeBytes: upload.sizeBytes,
      folderId: folderRaw,
      entityType,
      entityId,
      uploadedBy: actor.id,
    });

    await writeAudit({
      actorUserId: actor.id,
      action: 'uploaded',
      entityType: 'document',
      entityId: document.id,
      changes: { after: document },
      metadata: { storage_path: upload.path, size_bytes: upload.sizeBytes },
    });

    const signed_url = fileUrlForPath(document.storage_path);
    return NextResponse.json({ document: { ...document, signed_url } }, { status: 201 });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23503') return NextResponse.json({ error: 'invalid_reference' }, { status: 400 });
    console.error('[POST /api/documents]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

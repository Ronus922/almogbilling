import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, requireAnyPermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorApartmentNumber } from '@/lib/db/debtors';
import { listDocuments, insertDocument } from '@/lib/db/documents';
import { uploadDocumentFile, fileUrlForPath } from '@/lib/storage/documentStorage';
import { MAX_FILE_NAME_LEN } from '@/lib/constants/documents';
import { writeAudit } from '@/lib/db/audit';
import type { DocumentWithSignedUrl } from '@/lib/types/documents';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const ENTITY_TYPE = 'debtor';

// Debtor attachments use a narrower whitelist + smaller cap than the generic
// documents module (which allows 25MB + more types). Enforced server-side.
const DEBTOR_DOC_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // xlsx
  'image/jpeg',
  'image/png',
];
const MAX_DEBTOR_DOC_BYTES = 10 * 1024 * 1024; // 10MB

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/debtors/[id]/documents  — this debtor's documents (desc), each with a
// fresh signed URL. Read is granted by `dashboard` (viewer) OR `contacts` (manager).
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

  const { id } = await ctx.params;
  const documents = await listDocuments({ entityType: ENTITY_TYPE, entityId: id });
  const withUrls: DocumentWithSignedUrl[] = await Promise.all(
    documents.map(async (d) => ({
      ...d,
      signed_url: fileUrlForPath(d.storage_path),
    })),
  );
  return NextResponse.json({ documents: withUrls });
}

// POST /api/debtors/[id]/documents  (contacts:edit) — multipart upload.
// Uploads to Supabase Storage under a random ASCII UUID key; the (Hebrew)
// original name is kept only in documents.file_name.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('contacts', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const apt = await getDebtorApartmentNumber(id);
  if (!apt) return NextResponse.json({ error: 'not_found' }, { status: 404 });

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
  if (!DEBTOR_DOC_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }
  if (file.size > MAX_DEBTOR_DOC_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }

  // Readable display name (the possibly-Hebrew original), clamped to the column
  // limit so an oversized name can never reject the row.
  const displayName = (file.name || 'document').trim().slice(0, MAX_FILE_NAME_LEN);

  let upload: { path: string; sizeBytes: number; mimeType: string };
  try {
    upload = await uploadDocumentFile(file, { entityType: ENTITY_TYPE, entityId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[POST /api/debtors/:id/documents] storage not configured');
      return NextResponse.json({ error: 'storage_not_configured' }, { status: 503 });
    }
    logger.error('[POST /api/debtors/:id/documents] upload failed', err);
    return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
  }

  try {
    const document = await insertDocument({
      fileName: displayName,
      storagePath: upload.path,
      mimeType: upload.mimeType || null,
      sizeBytes: upload.sizeBytes,
      folderId: null,
      entityType: ENTITY_TYPE,
      entityId: id,
      uploadedBy: actor.id,
    });

    await writeAudit({
      actorUserId: actor.id,
      action: 'uploaded',
      entityType: 'document',
      entityId: document.id,
      changes: { after: document },
      metadata: { debtor_id: id, storage_path: upload.path, size_bytes: upload.sizeBytes },
    });

    const signed_url = fileUrlForPath(document.storage_path);
    return NextResponse.json({ document: { ...document, signed_url } }, { status: 201 });
  } catch (err) {
    logger.error('[POST /api/debtors/:id/documents]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

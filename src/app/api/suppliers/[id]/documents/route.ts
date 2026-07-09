import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getSupplierById,
  listSupplierDocuments,
  insertSupplierDocument,
} from '@/lib/db/suppliers';
import {
  uploadSupplierFile,
  fileUrlForPath,
} from '@/lib/storage/supplierStorage';
import { ALLOWED_DOC_TYPES, MAX_DOC_SIZE_BYTES } from '@/lib/constants/suppliers';
import { writeAudit } from '@/lib/db/audit';
import type { SupplierDocument } from '@/lib/types/suppliers';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// GET /api/suppliers/[id]/documents (suppliers:view)
export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('suppliers', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const rows = await listSupplierDocuments(id);
  const documents: (SupplierDocument & { signed_url: string | null })[] = await Promise.all(
    rows.map(async (doc) => ({
      ...doc,
      signed_url: fileUrlForPath(doc.file_url),
    })),
  );
  return NextResponse.json({ documents });
}

// POST /api/suppliers/[id]/documents (suppliers:edit) — multipart upload.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('suppliers', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;

  const supplier = await getSupplierById(id);
  if (!supplier) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const file = form.get('file');
  const docType = String(form.get('doc_type') ?? '');
  // Optional editable display name (default = the original file name).
  const displayName = String(form.get('file_name') ?? '').trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!ALLOWED_DOC_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'invalid_file_type' }, { status: 400 });
  }
  if (file.size > MAX_DOC_SIZE_BYTES) {
    return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
  }

  try {
    // Storage path is always derived from the real file (preserves extension);
    // file_name is the user-facing display name and is independent of it.
    const { path, sizeBytes, mimeType } = await uploadSupplierFile(id, file);
    const fileName = (displayName || file.name).slice(0, 200);
    const document = await insertSupplierDocument({
      supplierId: id,
      fileName,
      fileUrl: path,
      fileSizeBytes: sizeBytes,
      mimeType,
      docType: docType || 'general',
      uploadedBy: actor.id,
      uploadedByName: actor.full_name ?? actor.username,
    });
    await writeAudit({
      actorUserId: actor.id,
      action: 'document_uploaded',
      entityType: 'supplier',
      entityId: id,
      metadata: { document_id: document.id, file_name: fileName },
    });
    const signed_url = fileUrlForPath(document.file_url);
    return NextResponse.json({ document: { ...document, signed_url } }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/suppliers/:id/documents]', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

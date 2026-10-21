import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { countFiles, findDocument, insertFile } from '@/lib/db/purchasing';
import { removePurchasingObjects, uploadPurchasingObject } from '@/lib/storage/purchasingStorage';
import { buildProxyUrl, PURCHASING_FILES_BUCKET } from '@/lib/storage/server';
import { isUploadError, readAttachment } from '@/lib/purchasing/upload';
import { PURCHASING_LIMITS } from '@/lib/purchasing/model';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/purchasing/documents/[id]/files — multipart { file }: an attachment
// of the document (e.g. a drawing the suppliers should see with the request).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('purchasing', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!(await findDocument(id))) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'יש לצרף קובץ' }, { status: 400 });

  if ((await countFiles({ document_id: id })) >= PURCHASING_LIMITS.staffFilesMax) {
    return NextResponse.json({ error: `אפשר לצרף עד ${PURCHASING_LIMITS.staffFilesMax} קבצים` }, { status: 400 });
  }
  const read = await readAttachment(file, PURCHASING_LIMITS.staffFileBytes);
  if (isUploadError(read)) return NextResponse.json({ error: read.error }, { status: 400 });

  let uploaded: { objectKey: string; sizeBytes: number };
  try { uploaded = await uploadPurchasingObject(read.bytes, read.name, read.mime); }
  catch (err) {
    logger.error('[purchasing/files] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502 });
  }
  try {
    const row = await insertFile({
      document_id: id, quote_id: null, object_key: uploaded.objectKey, original_filename: read.name,
      mime_type: read.mime, file_size: uploaded.sizeBytes, uploaded_via: 'staff', uploaded_by: actor.id,
    });
    return NextResponse.json({ ...row, url: buildProxyUrl(PURCHASING_FILES_BUCKET, row.object_key) }, { status: 201 });
  } catch (err) {
    await removePurchasingObjects([uploaded.objectKey]);
    logger.error('[purchasing/files] insert failed', err);
    return NextResponse.json({ error: 'שמירת הקובץ נכשלה' }, { status: 500 });
  }
}

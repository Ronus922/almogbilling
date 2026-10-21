import { NextResponse, type NextRequest } from 'next/server';
import { countFiles, findPublicContext, insertFile } from '@/lib/db/purchasing';
import { removePurchasingObjects, uploadPurchasingObject } from '@/lib/storage/purchasingStorage';
import { PUBLIC_HEADERS, publicWriteGate } from '@/lib/purchasing/publicGate';
import { isRfqOpen, PURCHASING_LIMITS } from '@/lib/purchasing/model';
import { isUploadError, readAttachment } from '@/lib/purchasing/upload';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// PUBLIC (token-gated) — POST multipart { file }: the supplier's optional file
// with its quote (the quote must already be saved). Type + size + magic-byte
// checked, at most 3 files of 10MB, only while the request is open.
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const blocked = await publicWriteGate(req, token);
  if (blocked) return blocked;
  const found = await findPublicContext(token);
  if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: PUBLIC_HEADERS });
  if (!isRfqOpen(found.rfq.due_date)) {
    return NextResponse.json({ error: 'closed', message: 'חלף תאריך היעד להגשה' }, { status: 403, headers: PUBLIC_HEADERS });
  }
  if (!found.quote) {
    return NextResponse.json({ error: 'יש לשמור את ההצעה לפני צירוף קובץ' }, { status: 409, headers: PUBLIC_HEADERS });
  }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400, headers: PUBLIC_HEADERS }); }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'יש לצרף קובץ' }, { status: 400, headers: PUBLIC_HEADERS });

  const mine = found.quote.files.filter((f) => f.uploaded_via === 'supplier').length;
  if (mine >= PURCHASING_LIMITS.supplierFilesMax || (await countFiles({ quote_id: found.quote.id })) >= PURCHASING_LIMITS.staffFilesMax) {
    return NextResponse.json({ error: `אפשר לצרף עד ${PURCHASING_LIMITS.supplierFilesMax} קבצים` }, { status: 400, headers: PUBLIC_HEADERS });
  }
  const read = await readAttachment(file, PURCHASING_LIMITS.supplierFileBytes);
  if (isUploadError(read)) return NextResponse.json({ error: read.error }, { status: 400, headers: PUBLIC_HEADERS });

  let uploaded: { objectKey: string; sizeBytes: number };
  try { uploaded = await uploadPurchasingObject(read.bytes, read.name, read.mime); }
  catch (err) {
    logger.error('[public quote files] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502, headers: PUBLIC_HEADERS });
  }
  try {
    const row = await insertFile({
      document_id: null, quote_id: found.quote.id, object_key: uploaded.objectKey, original_filename: read.name,
      mime_type: read.mime, file_size: uploaded.sizeBytes, uploaded_via: 'supplier', uploaded_by: null,
    });
    return NextResponse.json({ id: row.id, name: row.original_filename, size: row.file_size, mine: true }, { status: 201, headers: PUBLIC_HEADERS });
  } catch (err) {
    await removePurchasingObjects([uploaded.objectKey]);
    logger.error('[public quote files] insert failed', err);
    return NextResponse.json({ error: 'שמירת הקובץ נכשלה' }, { status: 500, headers: PUBLIC_HEADERS });
  }
}

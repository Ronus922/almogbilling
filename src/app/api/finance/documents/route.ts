import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { insertStagedDocument } from '@/lib/db/finance/documents';
import { uploadFinanceReceipt, removeFinanceReceipt } from '@/lib/storage/financeReceiptStorage';
import { receiptCanonicalMime, receiptExt, validateFinanceReceipt } from '@/lib/constants/finance';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/finance/documents — stage ONE receipt (multipart/form-data, field
// `file`). The bytes go to the PRIVATE finance-receipts bucket under a UUID key
// and get a fin_documents row with entry_id NULL; POST/PATCH /api/finance/entries
// links it by id on save, and only then is it backed up to Drive. The server is
// the source of truth for type / MIME / size (validateFinanceReceipt); the
// count cap is enforced at save time, where the whole set is known.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('finance', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'שדה קובץ חסר' }, { status: 400 });

  const invalid = validateFinanceReceipt({ name: file.name, size: file.size, type: file.type });
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  const mime = receiptCanonicalMime(receiptExt(file.name)) ?? 'application/octet-stream';

  let upload: { objectKey: string; sizeBytes: number };
  try {
    upload = await uploadFinanceReceipt(file, mime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[POST /api/finance/documents] storage not configured');
      return NextResponse.json({ error: 'האחסון אינו מוגדר — פנה למנהל המערכת' }, { status: 503 });
    }
    logger.error('[POST /api/finance/documents] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502 });
  }

  try {
    const row = await insertStagedDocument({
      uploadedBy: actor.id,
      objectKey: upload.objectKey,
      originalName: file.name.slice(0, 300),
      mime,
      size: upload.sizeBytes,
    });
    return NextResponse.json({ id: row.id, original_name: row.original_name, mime: row.mime, size: row.size }, { status: 201 });
  } catch (err) {
    // The object is orphaned without its row — remove it so nothing lingers.
    await removeFinanceReceipt(upload.objectKey);
    logger.error('[POST /api/finance/documents] insert failed', err);
    return NextResponse.json({ error: 'שמירת הקובץ נכשלה' }, { status: 500 });
  }
}

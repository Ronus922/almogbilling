import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { insertStagedAttachment } from '@/lib/wa-queue/attachments';
import {
  uploadWhatsAppAttachment,
  removeWhatsAppAttachment,
  WHATSAPP_ATTACHMENTS_BUCKET,
} from '@/lib/storage/whatsappAttachmentStorage';
import {
  attachmentExt, canonicalMime, validateBroadcastAttachment,
} from '@/lib/constants/whatsappAttachments';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/whatsapp/campaigns/attachments — stage ONE broadcast attachment
// (whatsapp_chat:edit). multipart/form-data, field `file`. The file goes to the
// private whatsapp-attachments bucket under a UUID key and gets a
// wa_campaign_attachments row with campaign_id NULL; POST /api/whatsapp/campaigns
// links it by id at submit. The server is the source of truth for type / MIME /
// size (validateBroadcastAttachment) — the client pre-check is a courtesy.
// Staged rows never linked within 24h have their Storage OBJECT collected by
// the GC (scripts/storage-cleanup.ts, billing-storage-cleanup.timer) once it is
// armed. The ROW itself is left in place — row cleanup is a separate decision.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'שדה קובץ חסר' }, { status: 400 });

  const invalid = validateBroadcastAttachment({ name: file.name, size: file.size, type: file.type });
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  // validateBroadcastAttachment guarantees an allowed extension → a canonical MIME.
  const mimeType = canonicalMime(attachmentExt(file.name)) ?? 'application/octet-stream';

  let upload: { objectKey: string; sizeBytes: number };
  try {
    upload = await uploadWhatsAppAttachment(file, mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[POST /api/whatsapp/campaigns/attachments] storage not configured');
      return NextResponse.json({ error: 'האחסון אינו מוגדר — פנה למנהל המערכת' }, { status: 503 });
    }
    logger.error('[POST /api/whatsapp/campaigns/attachments] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502 });
  }

  try {
    const row = await insertStagedAttachment(getDbPool(), {
      uploadedBy: actor.id,
      bucket: WHATSAPP_ATTACHMENTS_BUCKET,
      objectKey: upload.objectKey,
      originalName: file.name.slice(0, 300),
      mimeType,
      sizeBytes: upload.sizeBytes,
    });
    return NextResponse.json(
      { id: row.id, original_name: row.original_name, mime_type: row.mime_type, size_bytes: row.size_bytes },
      { status: 201 },
    );
  } catch (err) {
    // The object is orphaned without its row — remove it so nothing lingers.
    await removeWhatsAppAttachment(upload.objectKey);
    logger.error('[POST /api/whatsapp/campaigns/attachments] insert failed', err);
    return NextResponse.json({ error: 'שמירת הקובץ נכשלה' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { insertStagedAttachment, toAttachmentView } from '@/lib/db/userReminderAttachments';
import { uploadReminderAttachment, removeReminderAttachment } from '@/lib/storage/reminderAttachmentStorage';
import { reminderAttachmentMime, validateReminderAttachment } from '@/lib/constants/reminderAttachments';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/user-reminders/attachments — stage ONE file (multipart/form-data,
// field `file`). The bytes go to the PRIVATE reminder-attachments bucket under a
// UUID key and get a user_reminder_attachments row with reminder_id NULL;
// POST /api/user-reminders and PATCH /api/user-reminders/[id] link it by id on
// save. The server is the source of truth for type / MIME / size
// (validateReminderAttachment); the count cap is enforced at save time, where
// the whole set is known. Same flow as /api/finance/documents.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try { actor = await requirePermission('user_reminders', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 }); }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'שדה קובץ חסר' }, { status: 400 });

  const invalid = validateReminderAttachment({ name: file.name, size: file.size, type: file.type });
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  const mime = reminderAttachmentMime(file.name) ?? 'application/octet-stream';

  let upload: { objectKey: string; sizeBytes: number };
  try {
    upload = await uploadReminderAttachment(file, mime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[POST /api/user-reminders/attachments] storage not configured');
      return NextResponse.json({ error: 'האחסון אינו מוגדר — פנה למנהל המערכת' }, { status: 503 });
    }
    logger.error('[POST /api/user-reminders/attachments] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502 });
  }

  try {
    const row = await insertStagedAttachment({
      uploadedBy: actor.id,
      objectKey: upload.objectKey,
      originalName: file.name.slice(0, 300),
      mime,
      size: upload.sizeBytes,
    });
    return NextResponse.json(toAttachmentView(row), { status: 201 });
  } catch (err) {
    // The object is orphaned without its row — remove it so nothing lingers.
    await removeReminderAttachment(upload.objectKey);
    logger.error('[POST /api/user-reminders/attachments] insert failed', err);
    return NextResponse.json({ error: 'שמירת הקובץ נכשלה' }, { status: 500 });
  }
}

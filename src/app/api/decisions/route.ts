import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { insertDecision, listDecisions } from '@/lib/db/portalDecisions';
import { removeDecisionFile, uploadDecisionFile } from '@/lib/storage/decisionStorage';
import {
  DECISION_FILE, DECISION_NUMBER_MAX, DECISION_SUMMARY_MAX, DECISION_TITLE_MAX,
  isDecisionType, validateDecisionFile,
} from '@/lib/decisions';
import { toDecisionAdminView } from '@/lib/decisionsView';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/decisions — the CRM list: EVERY decision and protocol, hidden ones
// included, newest decision first. Gate: portal_decisions:view (admin /
// super_admin). The portal has its own list route, which never sees a hidden
// row.
export async function GET() {
  try {
    await requirePermission('portal_decisions', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const rows = await listDecisions();
  return NextResponse.json({ decisions: rows.map(toDecisionAdminView) });
}

/**
 * POST /api/decisions — upload ONE PDF with its metadata (multipart:
 * file, title, doc_type, decision_number?, decided_at, summary?).
 *
 * One request, one document: there is no staged upload here because there is
 * nothing to stage against — the row IS the document. The object goes up
 * first and the row a moment later; if the insert fails the object is removed,
 * so portal_decisions.object_key is always claimed by a live row and the
 * Storage GC never meets an orphan it has to age out.
 *
 * The server is the source of truth for the file rule (PDF by extension AND by
 * MIME, ≤ 50MB — validateDecisionFile, the same function the panel pre-checks
 * with) and for the text limits.
 */
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('portal_decisions', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'יש לצרף קובץ PDF' }, { status: 400 });
  const fileError = validateDecisionFile({ name: file.name, size: file.size, type: file.type });
  if (fileError) return NextResponse.json({ error: fileError }, { status: 400 });

  const str = (k: string) => (typeof form.get(k) === 'string' ? (form.get(k) as string).trim() : '');
  const title = str('title');
  const docType = str('doc_type');
  const decidedAt = str('decided_at');
  const summary = str('summary');
  const decisionNumber = str('decision_number');

  if (!title) return NextResponse.json({ error: 'יש להזין כותרת' }, { status: 400 });
  if (title.length > DECISION_TITLE_MAX) return NextResponse.json({ error: 'הכותרת ארוכה מדי' }, { status: 400 });
  if (!isDecisionType(docType)) return NextResponse.json({ error: 'יש לבחור סוג מסמך' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decidedAt) || Number.isNaN(Date.parse(decidedAt))) {
    return NextResponse.json({ error: 'יש לבחור תאריך החלטה' }, { status: 400 });
  }
  if (summary.length > DECISION_SUMMARY_MAX) return NextResponse.json({ error: 'התקציר ארוך מדי' }, { status: 400 });
  if (decisionNumber.length > DECISION_NUMBER_MAX) {
    return NextResponse.json({ error: 'מספר ההחלטה ארוך מדי' }, { status: 400 });
  }

  let upload: { objectKey: string; sizeBytes: number };
  try {
    upload = await uploadDecisionFile(file, DECISION_FILE.mime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('supabase_storage_not_configured')) {
      logger.error('[POST /api/decisions] storage not configured');
      return NextResponse.json({ error: 'האחסון אינו מוגדר — פנה למנהל המערכת' }, { status: 503 });
    }
    logger.error('[POST /api/decisions] upload failed', err);
    return NextResponse.json({ error: 'העלאת הקובץ נכשלה' }, { status: 502 });
  }

  try {
    const row = await insertDecision({
      title,
      summary: summary || null,
      docType,
      // A number belongs to a decision only — a protocol never shows one.
      decisionNumber: docType === 'decision' && decisionNumber ? decisionNumber : null,
      decidedAt,
      objectKey: upload.objectKey,
      originalFilename: file.name.slice(0, 300),
      fileSize: upload.sizeBytes,
      mimeType: DECISION_FILE.mime,
      published: true,
      createdBy: actor.id,
    });
    return NextResponse.json(toDecisionAdminView(row), { status: 201 });
  } catch (err) {
    // The object is orphaned without its row — remove it so nothing lingers.
    await removeDecisionFile(upload.objectKey);
    logger.error('[POST /api/decisions] insert failed', err);
    return NextResponse.json({ error: 'שמירת המסמך נכשלה' }, { status: 500 });
  }
}

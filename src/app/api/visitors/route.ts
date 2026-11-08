import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorCreate, requireVisitorView } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { writeAudit } from '@/lib/db/audit';
import { findRecentDuplicate, insertVisitorScan, getVisitorScan, listVisitorScans } from '@/lib/db/visitorScans';
import { removeVisitorPhoto, uploadVisitorPhoto } from '@/lib/storage/visitorIdStorage';
import { prepareVisitorImage, VisitorImageError } from '@/lib/visitors/image';
import { MAX_VISITOR_IMAGE_BYTES, VISITOR_PAGE_SIZE } from '@/lib/visitors/model';
import { visitorCreateSchema, visitorListQuerySchema } from '@/lib/validation/visitors';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const SAVE_MAX_PER_HOUR = 120;

// GET /api/visitors — the table. Every role may read it (VISITOR_VIEW_ROLES).
// Newest first, 25 to a page; `q` is a name (either order) or part of a phone,
// `from`/`to` an inclusive day range in Israel time.
export async function GET(req: NextRequest) {
  try {
    await requireVisitorView();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const sp = req.nextUrl.searchParams;
  const parsed = visitorListQuerySchema.safeParse({
    q: sp.get('q') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    page: sp.get('page') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'פרמטרים לא תקינים' }, { status: 400 });

  const { q, from, to, page } = parsed.data;
  const { rows, total } = await listVisitorScans({ q, from: from ?? null, to: to ?? null, page });
  // Personal data on a shared phone / desk PC: never kept by a cache.
  return NextResponse.json({ rows, total, page, page_size: VISITOR_PAGE_SIZE }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// POST /api/visitors — step 2 of a scan: save the row. multipart: `image` (the
// photo, normally the normalised JPEG the OCR step returned) and `data` (the
// fields as JSON). The photo is re-normalised here — a client is never trusted
// to have done it — stored in the private bucket, and only then the row is
// written; if the row cannot be written the photo is removed again.
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireVisitorCreate();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // Every save runs the image pipeline and writes to the Storage this server shares with
  // other projects: 120 an hour per user is far above a gate and far below a runaway.
  const limit = await checkRateLimit(`visitor-save:user:${actor.id}`, { max: SAVE_MAX_PER_HOUR, windowSec: 60 * 60 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי שמירות בשעה האחרונה — נסה שוב מאוחר יותר' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_VISITOR_IMAGE_BYTES + 64 * 1024) {
    return NextResponse.json({ error: 'התמונה גדולה מדי' }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }
  const file = form.get('image');
  const rawData = form.get('data');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'חסר צילום של התעודה' }, { status: 400 });
  }
  if (file.size > MAX_VISITOR_IMAGE_BYTES) {
    return NextResponse.json({ error: 'התמונה גדולה מדי' }, { status: 413 });
  }
  if (typeof rawData !== 'string') return NextResponse.json({ error: 'חסרים פרטי הסריקה' }, { status: 400 });

  let json: unknown;
  try {
    json = JSON.parse(rawData);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = visitorCreateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  // A "שמור" pressed twice (the first answer lost on a bad connection) must not leave two rows
  // and two photos: the same person, same document, same user within 3 minutes is the same scan.
  const again = await findRecentDuplicate(actor.id, parsed.data);
  if (again) return NextResponse.json({ id: again, scan: await getVisitorScan(again), duplicate: true }, { status: 200 });

  let jpeg: Buffer;
  try {
    jpeg = (await prepareVisitorImage(Buffer.from(await file.arrayBuffer()))).jpeg;
  } catch (err) {
    if (err instanceof VisitorImageError) {
      const big = err.code === 'too_large';
      return NextResponse.json(
        { error: big ? 'התמונה גדולה מדי — צלם ברזולוציה נמוכה יותר' : 'לא ניתן לפתוח את התמונה — צלם שוב' },
        { status: big ? 413 : 422 },
      );
    }
    throw err;
  }

  let objectKey: string;
  try {
    objectKey = await uploadVisitorPhoto(jpeg);
  } catch (err) {
    logger.error('[POST /api/visitors] photo upload failed', { message: err instanceof Error ? err.message : 'unknown' });
    return NextResponse.json({ error: 'שמירת הצילום נכשלה — נסה שוב' }, { status: 502 });
  }

  let id: string;
  try {
    id = await insertVisitorScan({
      ...parsed.data,
      image_object_key: objectKey,
      image_original_name: file.name ? file.name.slice(0, 200) : null,
      scanned_by: actor.id,
    });
  } catch (err) {
    // The row is the record: without it the photo is an orphan nobody can reach.
    await removeVisitorPhoto(objectKey);
    // Only the SQLSTATE and constraint: a pg error's `detail` quotes the failing row,
    // i.e. a document number, and error() also goes to Sentry.
    const e = err as { code?: string; constraint?: string };
    logger.error('[POST /api/visitors] insert failed', { code: e.code, constraint: e.constraint });
    return NextResponse.json({ error: 'שמירת הסריקה נכשלה — נסה שוב' }, { status: 500 });
  }

  // No document number, birth date or name in the audit row: it records WHO scanned
  // WHICH row; the row itself holds the personal data, once.
  await writeAudit({
    actorUserId: actor.id,
    action: 'created',
    entityType: 'visitor_scan',
    entityId: id,
    metadata: { document_type: parsed.data.document_type, actor_role: actor.role },
  });

  const scan = await getVisitorScan(id);
  return NextResponse.json({ id, scan }, { status: 201 });
}

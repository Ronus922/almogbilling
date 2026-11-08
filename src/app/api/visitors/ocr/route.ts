import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorCreate } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { prepareVisitorImage, VisitorImageError } from '@/lib/visitors/image';
import { readVisitorDocument } from '@/lib/visitors/ocr';
import { MAX_VISITOR_IMAGE_BYTES, type OcrResponse } from '@/lib/visitors/model';

export const runtime = 'nodejs';

// POST /api/visitors/ocr — step 1 of a scan. Takes the photo, normalises it
// (HEIC → JPEG, upright, ≤1600px, no metadata), asks Claude to read it and hands
// back the fields PLUS that normalised photo. NOTHING is stored here: the photo
// reaches Storage only when the row is saved (POST /api/visitors), so an
// abandoned scan leaves no trace.
//
// Guard / admin / super admin only (requireVisitorCreate). Each call is a paid
// vision request, so a user gets 60 per 10 minutes — far above a gate's pace,
// far below a loop gone wrong.

const OCR_MAX_PER_WINDOW = 60;
const OCR_WINDOW_SEC = 10 * 60;
// A second, daily ceiling: a guard scans a few hundred documents a day at the very most,
// and the API key is shared with the personal assistant.
const OCR_MAX_PER_DAY = 400;
const OCR_DAY_SEC = 24 * 60 * 60;

export async function POST(req: NextRequest) {
  let actorId: string;
  try {
    actorId = (await requireVisitorCreate()).id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const limit = await checkRateLimit(`visitor-ocr:user:${actorId}`, { max: OCR_MAX_PER_WINDOW, windowSec: OCR_WINDOW_SEC });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי סריקות בזמן קצר — נסה שוב בעוד כמה דקות' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }
  const daily = await checkRateLimit(`visitor-ocr-day:user:${actorId}`, { max: OCR_MAX_PER_DAY, windowSec: OCR_DAY_SEC });
  if (!daily.allowed) {
    return NextResponse.json(
      { error: 'הגעת למכסת הסריקות היומית — אפשר למלא את הפרטים ידנית' },
      { status: 429, headers: { 'Retry-After': String(daily.retryAfterSec) } },
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
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'לא נשלחה תמונה' }, { status: 400 });
  }
  if (file.size > MAX_VISITOR_IMAGE_BYTES) {
    return NextResponse.json({ error: 'התמונה גדולה מדי' }, { status: 413 });
  }

  let prepared;
  try {
    prepared = await prepareVisitorImage(Buffer.from(await file.arrayBuffer()));
  } catch (err) {
    if (err instanceof VisitorImageError) {
      const unsupported = err.code === 'unsupported';
      const message = unsupported
        ? 'הקובץ אינו תמונה נתמכת'
        : err.code === 'too_large'
          ? 'התמונה גדולה מדי — צלם ברזולוציה נמוכה יותר'
          : 'לא ניתן לפתוח את התמונה — צלם שוב';
      return NextResponse.json({ error: message }, { status: unsupported ? 415 : err.code === 'too_large' ? 413 : 422 });
    }
    throw err;
  }

  const ocr = await readVisitorDocument(prepared.jpeg);
  const body: OcrResponse = {
    ok: ocr.ok,
    fields: ocr.fields,
    confidence: ocr.confidence,
    image_base64: prepared.jpeg.toString('base64'),
  };
  return NextResponse.json(body);
}

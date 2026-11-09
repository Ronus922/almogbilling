import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorCreate } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { compressVisitorImage } from '@/lib/visitors/image';
import { readImageUpload } from '@/lib/visitors/upload';
import { readVisitorDocument } from '@/lib/visitors/ocr';
import type { OcrResponse } from '@/lib/visitors/model';

export const runtime = 'nodejs';

// POST /api/visitors/ocr — step 2 of a scan (step 1 is the guard's crop, in the
// browser, which also shrinks it to ≤2000px JPEG for the upload). Takes the CROPPED
// photo, compresses it (upright, ≤1600px, no metadata, a progressive JPEG ≤~300KB), asks Claude to
// read it and hands back the fields PLUS that compressed photo. NOTHING is stored here: the photo reaches Storage only
// when the row is saved (POST /api/visitors), so an abandoned scan leaves no
// trace — and the uncropped original never leaves the guard's phone at all.
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

  // ONE encode: the compressed photo (JPEG ≤300KB) is what the model reads, what the guard sees in
  // the preview, and — posted back by the save step — what Storage keeps.
  const up = await readImageUpload(req, compressVisitorImage);
  if (!up.ok) return up.response;
  const img = up.value;

  const ocr = await readVisitorDocument(img.bytes, img.contentType);
  const body: OcrResponse = {
    ok: ocr.ok,
    fields: ocr.fields,
    confidence: ocr.confidence,
    image_base64: img.bytes.toString('base64'),
    image_type: img.contentType,
    image_bytes: img.bytes.length,
  };
  return NextResponse.json(body);
}

import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorCreate } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { prepareVisitorImage } from '@/lib/visitors/image';
import { readImageUpload } from '@/lib/visitors/upload';
import { CLIENT_UPLOAD_MAX_SIDE } from '@/lib/visitors/model';

export const runtime = 'nodejs';

// POST /api/visitors/prepare — the fallback of the crop step. The browser crops the
// guard's photo ITSELF (nothing leaves the phone before the crop); the one case it
// cannot is a file it cannot draw — a HEIC outside Safari, say. For that file only,
// the photo comes here and goes back as an upright JPEG (≤2000px, no metadata) to be
// cropped on screen. NOTHING is stored and no OCR is asked: this is just the
// decoder this server already has (the same pipeline the save uses).
//
// Guard / admin / super admin only; 10 per 10 minutes a user. It is a RARE path (Safari
// draws a HEIC itself), and a HEIC decode takes seconds of the server's only thread — the
// security review of 09/11/2026 found 60 too generous for the cost.

const PREPARE_MAX_PER_WINDOW = 10;
const PREPARE_WINDOW_SEC = 10 * 60;

export async function POST(req: NextRequest) {
  let actorId: string;
  try {
    actorId = (await requireVisitorCreate()).id;
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const limit = await checkRateLimit(`visitor-prepare:user:${actorId}`, { max: PREPARE_MAX_PER_WINDOW, windowSec: PREPARE_WINDOW_SEC });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי תמונות בזמן קצר — נסה שוב בעוד כמה דקות' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  const up = await readImageUpload(req, (buf) => prepareVisitorImage(buf, CLIENT_UPLOAD_MAX_SIDE));
  if (!up.ok) return up.response;
  // A photo of an ID document on a shared screen: never kept by a cache.
  return new NextResponse(new Uint8Array(up.value.jpeg), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' },
  });
}

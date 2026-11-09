import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorCreate } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { readImageUpload } from '@/lib/visitors/upload';

export const runtime = 'nodejs';

// POST /api/visitors/prepare — the fallback of the crop step. The browser crops the
// guard's photo ITSELF (nothing leaves the phone before the crop); the one case it
// cannot is a file it cannot draw — a HEIC outside Safari, say. For that file only,
// the photo comes here and goes back as an upright JPEG (≤1600px, no metadata) to be
// cropped on screen. NOTHING is stored and no OCR is asked: this is just the
// decoder this server already has (the same pipeline the save uses).
//
// Guard / admin / super admin only; 60 per 10 minutes a user — a HEIC decode takes a
// second of the server's only thread.

const PREPARE_MAX_PER_WINDOW = 60;
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

  const up = await readImageUpload(req);
  if (!up.ok) return up.response;
  // A photo of an ID document on a shared screen: never kept by a cache.
  return new NextResponse(new Uint8Array(up.jpeg), {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' },
  });
}

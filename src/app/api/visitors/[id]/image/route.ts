import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorManage } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { writeAudit } from '@/lib/db/audit';
import { getVisitorScan, replaceVisitorImage } from '@/lib/db/visitorScans';
import { removeVisitorPhoto, uploadVisitorPhoto } from '@/lib/storage/visitorIdStorage';
import { readImageUpload } from '@/lib/visitors/upload';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECROP_MAX_PER_HOUR = 60;

// POST /api/visitors/[id]/image — "חתוך מחדש": an admin replaces the STORED photo of a
// scan with a re-cropped one (multipart `image`). admin / super admin only; the guard
// cannot touch a saved photo, exactly like every other field.
//
// New object first, then the row, then the old object: if the upload fails nothing
// changed; if the row cannot be updated the new object is removed again; if only the
// old object cannot be removed the row is already right and the admin is told (the key
// is in the audit row). The bucket is outside the Storage GC, so nothing else would
// ever find a photo left behind.
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor;
  try {
    actor = await requireVisitorManage();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const limit = await checkRateLimit(`visitor-recrop:user:${actor.id}`, { max: RECROP_MAX_PER_HOUR, windowSec: 60 * 60 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'יותר מדי חיתוכים בשעה האחרונה — נסה שוב מאוחר יותר' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
    );
  }

  if (!(await getVisitorScan(id))) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const up = await readImageUpload(req);
  if (!up.ok) return up.response;

  let newKey: string;
  try {
    newKey = await uploadVisitorPhoto(up.jpeg);
  } catch (err) {
    logger.error('[POST /api/visitors/[id]/image] photo upload failed', { message: err instanceof Error ? err.message : 'unknown' });
    return NextResponse.json({ error: 'שמירת הצילום נכשלה — נסה שוב' }, { status: 502 });
  }

  let oldKey: string | null;
  try {
    oldKey = await replaceVisitorImage(id, newKey);
  } catch (err) {
    await removeVisitorPhoto(newKey);
    const e = err as { code?: string; constraint?: string };
    logger.error('[POST /api/visitors/[id]/image] update failed', { code: e.code, constraint: e.constraint });
    return NextResponse.json({ error: 'החלפת הצילום נכשלה — נסה שוב' }, { status: 500 });
  }
  if (oldKey === null) {
    // Deleted by someone else between the check and the update.
    await removeVisitorPhoto(newKey);
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const oldRemoved = await removeVisitorPhoto(oldKey);
  // Keys are bare UUIDs - no personal data - and are what a manual clean-up would need.
  await writeAudit({
    actorUserId: actor.id,
    action: 'image_recropped',
    entityType: 'visitor_scan',
    entityId: id,
    metadata: { actor_role: actor.role, old_object_key: oldKey, new_object_key: newKey, old_photo_removed: oldRemoved },
  });
  return NextResponse.json({ scan: await getVisitorScan(id), old_photo_removed: oldRemoved });
}

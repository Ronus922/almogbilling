import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorManage } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { checkRateLimit } from '@/lib/auth/rateLimit';
import { writeAudit } from '@/lib/db/audit';
import { getVisitorScan, replaceVisitorImage } from '@/lib/db/visitorScans';
import { removeVisitorPhoto, uploadVisitorPhoto } from '@/lib/storage/visitorIdStorage';
import { compressVisitorImage } from '@/lib/visitors/image';
import { readImageUpload } from '@/lib/visitors/upload';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A stored photo's object key: a bare UUID and its extension (`.jpg`; `.webp` only for a row that the
 *  one-off conversion script has not reached yet). */
const OBJECT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$/i;
const RECROP_MAX_PER_HOUR = 60;

// POST /api/visitors/[id]/image — "חתוך מחדש": an admin replaces the STORED photo of a
// scan with a re-cropped one. multipart: `image` (the crop) and `from_key` (the object key of
// the photo that was cropped). admin / super admin only; the guard cannot touch a saved photo,
// exactly like every other field. The photo goes through the same compression as a new scan.
//
// `from_key` is a precondition: if another admin replaced the photo while this one was being
// cropped, the row no longer points at `from_key` and the answer is 409 — a stale crop must not
// overwrite (and delete) the newer photo.
//
// New object first, then the row, then the old object: if the upload fails nothing changed; if
// the row cannot be updated the new object is removed again; if only the old object cannot be
// removed the row is already right and the admin is told. The old key is logged BEFORE its
// removal and written to the audit row after, so a crash in between still leaves a trace — the
// bucket is outside the Storage GC, nothing else would ever find a photo left behind.
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

  const up = await readImageUpload(req, compressVisitorImage);
  if (!up.ok) return up.response;
  const img = up.value;
  const fromKey = up.form.get('from_key');
  if (typeof fromKey !== 'string' || !OBJECT_KEY_RE.test(fromKey)) {
    return NextResponse.json({ error: 'חסר מזהה הצילום שנחתך' }, { status: 400 });
  }

  let newKey: string;
  try {
    newKey = await uploadVisitorPhoto(img);
  } catch (err) {
    logger.error('[POST /api/visitors/[id]/image] photo upload failed', { message: err instanceof Error ? err.message : 'unknown' });
    return NextResponse.json({ error: 'שמירת הצילום נכשלה — נסה שוב' }, { status: 502 });
  }

  let result;
  try {
    result = await replaceVisitorImage(id, newKey, img.bytes.length, fromKey);
  } catch (err) {
    const removed = await removeVisitorPhoto(newKey);
    const e = err as { code?: string; constraint?: string };
    // Both keys (bare UUIDs) so that a commit whose acknowledgement was lost - the row already points
    // at newKey - or a new object that could not be removed can be settled by hand.
    logger.error('[POST /api/visitors/[id]/image] update failed', {
      code: e.code, constraint: e.constraint, scan_id: id, from_key: fromKey, new_object_key: newKey, new_object_removed: removed,
    });
    return NextResponse.json({ error: 'החלפת הצילום נכשלה — נסה שוב' }, { status: 500 });
  }
  if (result.kind !== 'replaced') {
    // Deleted (404) or replaced by someone else (409) between the check and the update.
    await removeVisitorPhoto(newKey);
    return result.kind === 'stale'
      ? NextResponse.json({ error: 'הצילום הוחלף בינתיים על ידי משתמש אחר — פתח את הסריקה מחדש' }, { status: 409 })
      : NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  logger.info('[visitors recrop] replacing the stored photo', { scan_id: id, old_object_key: result.oldKey, new_object_key: newKey });
  const oldRemoved = await removeVisitorPhoto(result.oldKey);
  // Keys are bare UUIDs - no personal data - and are what a manual clean-up would need.
  await writeAudit({
    actorUserId: actor.id,
    action: 'image_recropped',
    entityType: 'visitor_scan',
    entityId: id,
    metadata: {
      actor_role: actor.role,
      old_object_key: result.oldKey,
      new_object_key: newKey,
      new_image_bytes: img.bytes.length,
      old_photo_removed: oldRemoved,
    },
  });
  const scan = await getVisitorScan(id);
  if (!scan) return NextResponse.json({ error: 'not_found' }, { status: 404 }); // deleted right after the swap
  return NextResponse.json({ scan, old_photo_removed: oldRemoved });
}

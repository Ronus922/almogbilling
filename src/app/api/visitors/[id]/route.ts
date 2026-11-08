import { NextResponse, type NextRequest } from 'next/server';
import { requireVisitorEdit, requireVisitorManage } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { canManageVisitorScans } from '@/lib/permissions/check';
import { writeAudit } from '@/lib/db/audit';
import { deleteVisitorScan, updateVisitorScan } from '@/lib/db/visitorScans';
import { removeVisitorPhoto } from '@/lib/storage/visitorIdStorage';
import { bodyKeys, visitorNotesSchema, visitorUpdateSchema } from '@/lib/validation/visitors';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH /api/visitors/[id] — change a saved row.
//   admin / super admin : any of the form's fields.
//   guard               : the notes and NOTHING else. The other fields are locked
//                         HERE, not only in the screen: a body that names any other
//                         key is a 403 before anything is parsed or written.
export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  let actor;
  try {
    actor = await requireVisitorEdit();
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const keys = bodyKeys(raw);
  if (keys.length === 0) return NextResponse.json({ error: 'לא נשלח שום שדה לעדכון' }, { status: 400 });

  const manage = canManageVisitorScans(actor.role);
  if (!manage && keys.some((k) => k !== 'notes')) {
    return NextResponse.json({ error: 'אפשר לערוך רק את ההערות' }, { status: 403 });
  }

  const parsed = (manage ? visitorUpdateSchema : visitorNotesSchema).safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const scan = await updateVisitorScan(id, parsed.data);
  if (!scan) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // The names of the fields that changed, not their values — the row holds the data.
  await writeAudit({
    actorUserId: actor.id,
    action: 'updated',
    entityType: 'visitor_scan',
    entityId: id,
    metadata: { fields: Object.keys(parsed.data), actor_role: actor.role },
  });
  return NextResponse.json({ scan });
}

// DELETE /api/visitors/[id] — admin / super admin. The row goes, then its photo.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
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

  const objectKey = await deleteVisitorScan(id);
  if (objectKey === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const photoRemoved = await removeVisitorPhoto(objectKey);

  // The row is gone either way; if Storage refused, say so — the photo of an ID document
  // must not stay behind unseen. The key (a UUID, no personal data) goes to the audit row
  // and the log so it can be removed by hand.
  await writeAudit({
    actorUserId: actor.id,
    action: 'deleted',
    entityType: 'visitor_scan',
    entityId: id,
    metadata: { actor_role: actor.role, photo_removed: photoRemoved, ...(photoRemoved ? {} : { object_key: objectKey }) },
  });
  return NextResponse.json({ ok: true, photo_removed: photoRemoved });
}

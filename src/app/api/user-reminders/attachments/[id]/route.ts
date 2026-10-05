import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  deleteReminderAttachment, deleteStagedAttachment, getAttachment,
} from '@/lib/db/userReminderAttachments';
import { removeReminderAttachment } from '@/lib/storage/reminderAttachmentStorage';
import { writeAudit } from '@/lib/db/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/user-reminders/attachments/[id] — remove a file: either one the
// actor staged and took out of the panel again, or one already linked to a
// reminder (the edit panel's delete). The Storage object goes with the row.
// Same flow as DELETE /api/finance/documents/[id].
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('user_reminders', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });

  let row = await deleteStagedAttachment(id, actor.id);
  if (!row) {
    const att = await getAttachment(id);
    if (att?.reminder_id) row = await deleteReminderAttachment(id, att.reminder_id);
  }
  if (!row) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });

  await removeReminderAttachment(row.object_key);
  if (row.reminder_id) {
    await writeAudit({
      actorUserId: actor.id, action: 'attachment_removed', entityType: 'reminder', entityId: row.reminder_id,
      metadata: { attachment_id: id, name: row.original_name },
    });
  }
  return NextResponse.json({ ok: true });
}

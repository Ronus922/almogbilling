import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { deleteStagedMessageAttachment } from '@/lib/db/whatsappMessageAttachments';
import { removeWhatsAppAttachment } from '@/lib/storage/whatsappAttachmentStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteCtx { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DELETE /api/whatsapp/messages/attachments/[id] — drop a STAGED attachment the
// actor uploaded and has now removed from the composer (whatsapp:edit). Only a
// row that is still unlinked (message_id NULL) and owned by the actor can go:
// once the message was sent the file is part of its history.
export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await ctx.params;
  // The column is uuid: a malformed segment must read as "not found", not blow
  // up the query.
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });
  const row = await deleteStagedMessageAttachment(id, actor.id);
  if (!row) return NextResponse.json({ error: 'הקובץ לא נמצא' }, { status: 404 });

  await removeWhatsAppAttachment(row.object_key);
  return NextResponse.json({ ok: true });
}

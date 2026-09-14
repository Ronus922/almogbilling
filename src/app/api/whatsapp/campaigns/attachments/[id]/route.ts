import { NextResponse } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDbPool } from '@/lib/db';
import { deleteStagedAttachment } from '@/lib/wa-queue/attachments';
import { removeWhatsAppAttachment } from '@/lib/storage/whatsappAttachmentStorage';
import { UUID_RE } from '@/lib/validation/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/whatsapp/campaigns/attachments/[id] — the "X" on a staged file in
// the compose tab (whatsapp_chat:edit). Only the uploader may remove it, and only
// while it is still staged (campaign_id NULL): once a broadcast owns the file it
// is part of that broadcast's history. Unknown / foreign / linked → 404.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try { actor = await requirePermission('whatsapp_chat', 'edit'); }
  catch (err) { const r = authErrorResponse(err); if (r) return r; throw err; }

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const row = await deleteStagedAttachment(getDbPool(), id, actor.id);
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  await removeWhatsAppAttachment(row.object_key);
  return NextResponse.json({ ok: true });
}

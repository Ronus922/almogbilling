import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listParticipantIds } from '@/lib/db/internalChat';
import { emitChat } from '@/lib/whatsapp-events';

export const runtime = 'nodejs';

// POST /api/chat/conversations/[id]/typing — broadcast a transient "typing"
// signal to the conversation's OTHER participants. Participant-gated (no IDOR).
// Nothing is persisted; the receiver's indicator self-expires after ~3s.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let actor: Actor;
  try {
    actor = await requirePermission('internal_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await params;
  const participants = await listParticipantIds(id);
  if (!participants.includes(actor.id)) {
    // Not a participant (or conversation gone) — uniform 403, no existence leak.
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const recipients = participants.filter((uid) => uid !== actor.id);
  if (recipients.length > 0) {
    emitChat({
      type: 'typing',
      conversation_id: id,
      user_id: actor.id,
      user_name: actor.full_name ?? actor.username,
      recipient_ids: recipients,
    });
  }
  return new NextResponse(null, { status: 204 });
}

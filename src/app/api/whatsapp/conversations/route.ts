import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listConversations } from '@/lib/db/whatsappConversations';
import { resolveViewInstanceId, getInstanceCredsById } from '@/lib/db/whatsappInstances';
import { refreshStaleAvatars } from '@/lib/whatsapp-avatars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/conversations?search=…&instance_id=… — the inbox conversation
// list, scoped to ONE instance (the selected one for admins, the actor's own
// otherwise). Gated on the whatsapp_chat module (the /messages inbox surface).
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const search = req.nextUrl.searchParams.get('search') ?? '';
  const requestedInstance = req.nextUrl.searchParams.get('instance_id');
  const instanceId = await resolveViewInstanceId(actor, requestedInstance);

  // No instance resolvable → empty inbox (nothing connected yet).
  if (!instanceId) return NextResponse.json([]);

  const conversations = await listConversations(search, instanceId);

  // Lazily refresh a few stale profile pictures in the background (fire-and-forget,
  // capped + in-flight-guarded) using THIS instance's credentials. Does NOT delay
  // the response; the inbox polling fills the rest of the list over later requests.
  void getInstanceCredsById(instanceId).then((creds) =>
    refreshStaleAvatars(conversations.map((c) => c.chat_id), creds),
  );

  return NextResponse.json(conversations);
}

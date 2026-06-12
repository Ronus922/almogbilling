import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listConversations } from '@/lib/db/whatsappConversations';
import { refreshStaleAvatars } from '@/lib/whatsapp-avatars';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/conversations?search=… — the inbox conversation list.
// Gated on the whatsapp_chat module (the /messages inbox surface).
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const search = req.nextUrl.searchParams.get('search') ?? '';
  const conversations = await listConversations(search);

  // Lazily refresh a few stale profile pictures in the background (fire-and-forget,
  // capped + in-flight-guarded). Does NOT delay the response; the 5s inbox polling
  // fills the rest of the list in over subsequent requests.
  void refreshStaleAvatars(conversations.map((c) => c.chat_id));

  return NextResponse.json(conversations);
}

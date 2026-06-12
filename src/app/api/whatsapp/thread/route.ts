import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listThread } from '@/lib/db/whatsappConversations';
import { resolveViewInstanceId } from '@/lib/db/whatsappInstances';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/thread?chat_id=…&before=…&instance_id=… — chronological
// messages for one conversation (left panel), scoped to the selected instance.
export async function GET(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const chatId = req.nextUrl.searchParams.get('chat_id')?.trim();
  if (!chatId) {
    return NextResponse.json({ error: 'chat_id חסר' }, { status: 400 });
  }
  const before = req.nextUrl.searchParams.get('before')?.trim() || null;
  const instanceId = await resolveViewInstanceId(actor, req.nextUrl.searchParams.get('instance_id'));

  const messages = await listThread(chatId, before, instanceId);
  return NextResponse.json(messages);
}

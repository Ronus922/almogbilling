import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { listThread } from '@/lib/db/whatsappConversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/whatsapp/thread?chat_id=…&before=… — chronological messages for one
// conversation (the left panel). `before` is a created_at cursor for paging older.
export async function GET(req: NextRequest) {
  try {
    await requirePermission('whatsapp_chat', 'view');
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

  const messages = await listThread(chatId, before);
  return NextResponse.json(messages);
}

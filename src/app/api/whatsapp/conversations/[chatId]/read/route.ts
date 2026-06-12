import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markConversationRead } from '@/lib/db/whatsappConversations';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ chatId: string }>;
}

// POST /api/whatsapp/conversations/[chatId]/read — mark a conversation read.
// A side-effect of opening it; gated on whatsapp_chat:view (viewers may use the
// inbox). chatId is URL-encoded ("972…%40c.us").
export async function POST(_req: NextRequest, ctx: RouteCtx) {
  try {
    await requirePermission('whatsapp_chat', 'view');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { chatId } = await ctx.params;
  const decoded = decodeURIComponent(chatId).trim();
  if (!decoded) {
    return NextResponse.json({ error: 'chat_id חסר' }, { status: 400 });
  }

  const marked = await markConversationRead(decoded);
  return NextResponse.json({ ok: true, marked });
}

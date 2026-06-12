import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { markConversationRead } from '@/lib/db/whatsappConversations';
import { resolveViewInstanceId } from '@/lib/db/whatsappInstances';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ chatId: string }>;
}

// POST /api/whatsapp/conversations/[chatId]/read?instance_id=… — mark a
// conversation read (scoped to the selected instance). A side-effect of opening
// it; gated on whatsapp_chat:view. chatId is URL-encoded ("972…%40c.us").
export async function POST(req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'view');
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

  const instanceId = await resolveViewInstanceId(actor, req.nextUrl.searchParams.get('instance_id'));
  const marked = await markConversationRead(decoded, instanceId);
  return NextResponse.json({ ok: true, marked });
}

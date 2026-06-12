import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import {
  getResendableMessage,
  markMessageResent,
  markMessageResendFailed,
} from '@/lib/db/chatMessages';
import {
  resolveViewInstanceId,
  getInstanceCredsById,
} from '@/lib/db/whatsappInstances';
import {
  sendWhatsAppMessage,
  sendWhatsAppFileByUrl,
  WhatsAppError,
} from '@/lib/whatsapp';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/whatsapp/messages/[id]/resend — retry a failed OUTBOUND message.
// Updates the EXISTING row in place (no duplicate). Gated on whatsapp_chat:edit.
export async function POST(_req: NextRequest, ctx: RouteCtx) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { id } = await ctx.params;
  const msg = await getResendableMessage(id);
  if (!msg) {
    return NextResponse.json({ error: 'ההודעה לא נמצאה או שאינה במצב כשל' }, { status: 404 });
  }
  if (!msg.chat_id) {
    return NextResponse.json({ error: 'אין יעד לשליחה חוזרת' }, { status: 400 });
  }

  // Prefer the instance the message was originally sent from; fall back to the
  // actor's resolvable instance.
  let creds = msg.instance_id ? await getInstanceCredsById(msg.instance_id) : null;
  if (!creds) {
    const fallbackId = await resolveViewInstanceId(actor, null);
    creds = fallbackId ? await getInstanceCredsById(fallbackId) : null;
  }
  if (!creds) {
    return NextResponse.json({ error: 'לא מחובר מספר וואטסאפ לשליחה' }, { status: 503 });
  }

  try {
    let idMessage: string;
    if (msg.message_type !== 'text' && msg.media_url) {
      const fileName = msg.media_url.split('/').pop()?.split('?')[0] || 'file';
      ({ idMessage } = await sendWhatsAppFileByUrl({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        chatId: msg.chat_id,
        urlFile: msg.media_url,
        fileName,
        caption: msg.content ?? undefined,
      }));
    } else {
      ({ idMessage } = await sendWhatsAppMessage({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        chatId: msg.chat_id,
        message: msg.content ?? '',
      }));
    }
    await markMessageResent(id, idMessage);
    return NextResponse.json({ ok: true, idMessage });
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    await markMessageResendFailed(id, detail).catch(() => { /* best-effort */ });
    return NextResponse.json({ error: `שליחה נכשלה: ${detail}` }, { status: 502 });
  }
}

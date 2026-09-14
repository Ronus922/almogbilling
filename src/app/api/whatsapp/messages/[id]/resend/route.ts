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
import { listMessageAttachments } from '@/lib/db/whatsappMessageAttachments';
import { ensureAttachmentLinks } from '@/lib/whatsapp-send';
import { planMessageSends } from '@/lib/whatsapp-send-plan';
import { wireFileName } from '@/lib/wa-queue/attachments';

export const runtime = 'nodejs';

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// POST /api/whatsapp/messages/[id]/resend — retry a failed OUTBOUND message.
// Updates the EXISTING row in place (no duplicate). Gated on whatsapp_chat:edit.
//
// Attachments come from wa_message_attachments — ALL of them, in order — and are
// re-pushed to Green API when their 15-day link has expired. Messages sent before
// that table existed have no rows: those fall back to the single absolute
// media_url they were sent with.
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

  const files = await listMessageAttachments(id);
  const failedNames: string[] = [];

  try {
    let idMessage: string | null = null;

    if (files.length > 0) {
      const { ready, failed } = await ensureAttachmentLinks(files, creds);
      failedNames.push(...failed.map((f) => f.original_name));
      if (ready.length === 0 && !(msg.content ?? '').trim()) {
        throw new WhatsAppError('העלאת הקבצים נכשלה');
      }
      for (const step of planMessageSends(msg.content ?? '', ready.length)) {
        if (step.kind === 'text') {
          const r = await sendWhatsAppMessage({
            instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
            chatId: msg.chat_id, message: msg.content ?? '',
          });
          idMessage ??= r.idMessage;
          continue;
        }
        const f = ready[step.index];
        try {
          const r = await sendWhatsAppFileByUrl({
            instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
            chatId: msg.chat_id,
            urlFile: f.urlFile,
            fileName: wireFileName(f.row.original_name),
            ...(step.caption ? { caption: step.caption } : {}),
          });
          idMessage ??= r.idMessage;
        } catch (err) {
          // One file Green refused — the rest of the message still goes.
          failedNames.push(f.row.original_name);
          if (planMessageSends(msg.content ?? '', ready.length).length === 1) throw err;
        }
      }
    } else if (msg.message_type !== 'text' && msg.media_url?.startsWith('http')) {
      // Legacy row: one file, addressed by the absolute URL it was sent with.
      const fileName = msg.media_url.split('/').pop()?.split('?')[0] || 'file';
      const r = await sendWhatsAppFileByUrl({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        chatId: msg.chat_id,
        urlFile: msg.media_url,
        fileName,
        caption: msg.content ?? undefined,
      });
      idMessage = r.idMessage;
    } else {
      const r = await sendWhatsAppMessage({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        chatId: msg.chat_id,
        message: msg.content ?? '',
      });
      idMessage = r.idMessage;
    }

    if (!idMessage) throw new WhatsAppError('ההודעה לא נשלחה');
    await markMessageResent(id, idMessage);
    return NextResponse.json(
      { ok: true, idMessage, ...(failedNames.length ? { failed_attachments: failedNames } : {}) },
      failedNames.length ? { status: 207 } : undefined,
    );
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    await markMessageResendFailed(id, detail).catch(() => { /* best-effort */ });
    return NextResponse.json({ error: `שליחה נכשלה: ${detail}` }, { status: 502 });
  }
}

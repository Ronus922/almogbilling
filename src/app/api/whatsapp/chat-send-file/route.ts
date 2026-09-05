import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, type Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { getDebtorContactByPhone } from '@/lib/db/debtors';
import { insertChatMessage } from '@/lib/db/chatMessages';
import {
  resolveViewInstanceId,
  getInstanceCredsById,
  InstanceNotConfiguredError,
  type InstanceCreds,
} from '@/lib/db/whatsappInstances';
import {
  normalizePhone,
  chatIdToLocalPhone,
  sendWhatsAppFileByUrl,
  WhatsAppError,
} from '@/lib/whatsapp';
import { uploadWhatsAppMedia } from '@/lib/storage/whatsappMedia';
import type { ChatMessageType } from '@/types/whatsapp';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// POST /api/whatsapp/chat-send-file — send a media file from the inbox composer.
// Body: multipart/form-data with fields: file (File), chat_id?, phone?,
// instance_id?, caption?. One of chat_id / phone is required.
// Gated on whatsapp_chat:edit. Never returns 200 on a send failure.
export async function POST(req: NextRequest) {
  let actor: Actor;
  try {
    actor = await requirePermission('whatsapp_chat', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_form_data' }, { status: 400 });
  }

  const fileRaw = form.get('file');
  if (!(fileRaw instanceof File)) {
    return NextResponse.json({ error: 'שדה קובץ חסר' }, { status: 400 });
  }
  const file = fileRaw;

  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: 'הקובץ גדול מדי (מקסימום 50MB)' }, { status: 400 });
  }

  const chatIdIn = typeof form.get('chat_id') === 'string'
    ? (form.get('chat_id') as string).trim()
    : '';
  const phoneIn = typeof form.get('phone') === 'string'
    ? (form.get('phone') as string).trim()
    : '';
  const captionRaw = typeof form.get('caption') === 'string'
    ? (form.get('caption') as string).trim()
    : '';
  const caption = captionRaw.length > 0 ? captionRaw : null;

  if (caption !== null && caption.length > 1024) {
    return NextResponse.json({ error: 'הכיתוב ארוך מדי (מקסימום 1024 תווים)' }, { status: 400 });
  }

  const instanceIdIn = typeof form.get('instance_id') === 'string'
    ? (form.get('instance_id') as string).trim()
    : '';

  // Resolve the conversation target.
  let chatId: string;
  let isGroup = false;
  let localPhone: string | null = null;

  if (chatIdIn) {
    chatId = chatIdIn;
    isGroup = chatId.toLowerCase().endsWith('@g.us');
    if (!isGroup) {
      localPhone = chatIdToLocalPhone(chatId);
      if (!localPhone) {
        return NextResponse.json({ error: 'מזהה שיחה לא תקין' }, { status: 400 });
      }
    }
  } else if (phoneIn) {
    try {
      const norm = normalizePhone(phoneIn);
      chatId = norm.chatId;
      localPhone = '0' + norm.phone.slice(3);
    } catch (err) {
      const detail = err instanceof WhatsAppError ? err.message : 'מספר טלפון לא תקין';
      return NextResponse.json({ error: detail }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'יש לציין chat_id או phone' }, { status: 400 });
  }

  // Resolve the sending instance.
  let creds: InstanceCreds;
  try {
    const instanceDbId = await resolveViewInstanceId(actor, instanceIdIn || null);
    const resolved = instanceDbId ? await getInstanceCredsById(instanceDbId) : null;
    if (!resolved) throw new InstanceNotConfiguredError();
    creds = resolved;
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Upload the file; the returned URL is our own /api/public/wa-media address,
  // never the storage host.
  let url: string;
  let mimeType: string;
  try {
    const uploaded = await uploadWhatsAppMedia(file);
    url = uploaded.url;
    mimeType = uploaded.mimeType;
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'שגיאה בהעלאת הקובץ';
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const messageType: ChatMessageType = mimeType.startsWith('image/') ? 'image' : 'document';

  // Resolve the debtor for person chats (best-effort; null for groups).
  const debtor = !isGroup && localPhone
    ? await getDebtorContactByPhone(localPhone)
    : null;

  // Send via Green API.
  try {
    const { idMessage } = await sendWhatsAppFileByUrl({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId,
      urlFile: url,
      fileName: file.name,
      ...(caption !== null ? { caption } : {}),
    });

    await insertChatMessage({
      debtorId: debtor?.id ?? null,
      contactPhone: localPhone ?? chatId,
      chatId,
      externalMessageId: idMessage,
      direction: 'sent',
      messageType,
      linkStatus: 'linked',
      content: caption,
      mediaUrl: url,
      status: 'sent',
      sentBy: actor.id,
      instanceId: creds.id,
    });

    return NextResponse.json({ ok: true, idMessage, chat_id: chatId });
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';

    try {
      await insertChatMessage({
        debtorId: debtor?.id ?? null,
        contactPhone: localPhone ?? chatId,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        messageType,
        linkStatus: 'linked',
        content: caption,
        mediaUrl: url,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
        instanceId: creds.id,
      });
    } catch (insertErr) {
      logger.error('chat-send-file: failed to insert failure row:', insertErr);
    }

    return NextResponse.json({ error: `שליחה נכשלה: ${detail}` }, { status: 502 });
  }
}

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
  sendWhatsAppMessage,
  WhatsAppError,
} from '@/lib/whatsapp';
import { sendChatMessageToPhone } from '@/lib/whatsapp-chat-send';

export const runtime = 'nodejs';

interface PostBody {
  chat_id?: unknown;
  phone?: unknown;
  text?: unknown;
  /** Selected instance (admins viewing another employee's inbox). */
  instance_id?: unknown;
}

// POST /api/whatsapp/chat-send — send a free-text message from the inbox composer.
// Body: { chat_id?, phone?, text } (one of chat_id / phone required).
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

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const chatIdIn = typeof body.chat_id === 'string' ? body.chat_id.trim() : '';
  const phoneIn = typeof body.phone === 'string' ? body.phone.trim() : '';

  if (text.length < 1) {
    return NextResponse.json({ error: 'תוכן ההודעה ריק' }, { status: 400 });
  }
  if (text.length > 4096) {
    return NextResponse.json({ error: 'ההודעה ארוכה מדי (מקסימום 4096 תווים)' }, { status: 400 });
  }

  // Resolve the conversation target. A group chat_id ("…@g.us") sends directly;
  // a person chat resolves to an international phone + (maybe) a linked debtor.
  let chatId: string;
  let isGroup = false;
  let phoneIntl: string | null = null;
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
      phoneIntl = norm.phone;
      chatId = norm.chatId;
      localPhone = '0' + phoneIntl.slice(3);
    } catch (err) {
      const detail = err instanceof WhatsAppError ? err.message : 'מספר טלפון לא תקין';
      return NextResponse.json({ error: detail }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'יש לציין chat_id או phone' }, { status: 400 });
  }

  // Resolve the sending instance: the selected instance (admin) or the actor's
  // own. Send always goes through a connected instance the actor is allowed to use.
  const requestedInstanceId = typeof body.instance_id === 'string' ? body.instance_id.trim() : '';
  let creds: InstanceCreds;
  try {
    const instanceDbId = await resolveViewInstanceId(actor, requestedInstanceId || null);
    const resolved = instanceDbId ? await getInstanceCredsById(instanceDbId) : null;
    if (!resolved) throw new InstanceNotConfiguredError();
    creds = resolved;
  } catch (err) {
    if (err instanceof InstanceNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

  // Group conversation — direct send, no debtor link / timeline event.
  if (isGroup) {
    try {
      const { idMessage } = await sendWhatsAppMessage({
        instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
        chatId, message: text,
      });
      await insertChatMessage({
        debtorId: null,
        contactPhone: chatId,
        chatId,
        externalMessageId: idMessage,
        direction: 'sent',
        content: text,
        status: 'sent',
        sentBy: actor.id,
        instanceId: creds.id,
      });
      return NextResponse.json({ ok: true, idMessage, chat_id: chatId });
    } catch (err) {
      const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
      try {
        await insertChatMessage({
          debtorId: null, contactPhone: chatId, chatId, externalMessageId: null,
          direction: 'sent', content: text, status: 'failed', errorDetail: detail,
          sentBy: actor.id, instanceId: creds.id,
        });
      } catch { /* best-effort */ }
      return NextResponse.json({ error: `שליחה נכשלה: ${detail}` }, { status: 502 });
    }
  }

  // Person conversation. phoneIntl may be null when we came in via chat_id.
  if (!phoneIntl && localPhone) {
    try {
      phoneIntl = normalizePhone(localPhone).phone;
    } catch {
      return NextResponse.json({ error: 'מספר טלפון לא תקין' }, { status: 400 });
    }
  }
  if (!phoneIntl) {
    return NextResponse.json({ error: 'לא ניתן לקבוע נמען' }, { status: 400 });
  }

  const debtor = localPhone ? await getDebtorContactByPhone(localPhone) : null;
  const result = await sendChatMessageToPhone({ phoneIntl, text, debtor, actor, creds });

  if (!result.ok) {
    return NextResponse.json({ error: `שליחה נכשלה: ${result.error}` }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    idMessage: result.idMessage,
    chat_id: chatId,
    ...(result.warning ? { warning: result.warning } : {}),
  });
}

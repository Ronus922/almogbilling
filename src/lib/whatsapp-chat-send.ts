import 'server-only';
import { insertChatMessage } from '@/lib/db/chatMessages';
import { sendWhatsAppMessage, WhatsAppError } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';
import type { Actor } from '@/lib/auth/actor';
import type { DebtorContact } from '@/lib/db/debtors';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';

// Send one free-text message from the /messages inbox composer.
//   • Linked conversation (debtor known) → reuse sendAndRecordWhatsApp so the
//     debtor timeline event + last_whatsapp_sent_at bump stay consistent with
//     the rest of the app. Plain text has no {{placeholders}}, so interpolation
//     is a no-op.
//   • Unlinked conversation (arbitrary phone) → a lighter insert+send with no
//     debtor link or timeline event.

export interface ChatSendResult {
  ok: boolean;
  idMessage?: string;
  /** chat_messages row id (success or recorded-failure) for optimistic reconcile. */
  messageId?: string;
  error?: string;
  warning?: string;
}

export async function sendChatMessageToPhone(args: {
  /** Recipient in international form ("972XXXXXXXXX"). */
  phoneIntl: string;
  text: string;
  debtor: DebtorContact | null;
  actor: Actor;
  creds: InstanceCreds;
}): Promise<ChatSendResult> {
  const { phoneIntl, text, debtor, actor, creds } = args;

  if (debtor) {
    return sendAndRecordWhatsApp({
      debtor,
      phoneIntl,
      rawMessage: text,
      templateId: null,
      actor,
      creds,
    });
  }

  const chatId = `${phoneIntl}@c.us`;
  try {
    const { idMessage } = await sendWhatsAppMessage({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId,
      message: text,
    });
    const messageId = await insertChatMessage({
      debtorId: null,
      contactPhone: phoneIntl,
      chatId,
      externalMessageId: idMessage,
      direction: 'sent',
      content: text,
      status: 'sent',
      sentBy: actor.id,
      instanceId: creds.id,
    });
    return { ok: true, idMessage, messageId: messageId ?? undefined };
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    let failedId: string | null = null;
    try {
      failedId = await insertChatMessage({
        debtorId: null,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        content: text,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
        instanceId: creds.id,
      });
    } catch (logErr) {
      console.error('[whatsapp/chat-send] failed to record failed row', logErr);
    }
    return { ok: false, error: detail, messageId: failedId ?? undefined };
  }
}

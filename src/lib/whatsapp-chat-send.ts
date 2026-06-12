import 'server-only';
import { insertChatMessage } from '@/lib/db/chatMessages';
import { sendWhatsAppMessage, WhatsAppError } from '@/lib/whatsapp';
import { sendAndRecordWhatsApp } from '@/lib/whatsapp-send';
import type { Actor } from '@/lib/auth/actor';
import type { DebtorContact } from '@/lib/db/debtors';

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
  error?: string;
  warning?: string;
}

export async function sendChatMessageToPhone(args: {
  /** Recipient in international form ("972XXXXXXXXX"). */
  phoneIntl: string;
  text: string;
  debtor: DebtorContact | null;
  actor: Actor;
  instanceId: string;
  token: string;
}): Promise<ChatSendResult> {
  const { phoneIntl, text, debtor, actor, instanceId, token } = args;

  if (debtor) {
    return sendAndRecordWhatsApp({
      debtor,
      phoneIntl,
      rawMessage: text,
      templateId: null,
      actor,
      instanceId,
      token,
    });
  }

  const chatId = `${phoneIntl}@c.us`;
  try {
    const { idMessage } = await sendWhatsAppMessage({ instanceId, token, chatId, message: text });
    await insertChatMessage({
      debtorId: null,
      contactPhone: phoneIntl,
      chatId,
      externalMessageId: idMessage,
      direction: 'sent',
      content: text,
      status: 'sent',
      sentBy: actor.id,
    });
    return { ok: true, idMessage };
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    try {
      await insertChatMessage({
        debtorId: null,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        content: text,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
      });
    } catch (logErr) {
      console.error('[whatsapp/chat-send] failed to record failed row', logErr);
    }
    return { ok: false, error: detail };
  }
}

import 'server-only';
import type { Actor } from '@/lib/auth/actor';
import { withTransaction } from '@/lib/db';
import type { DebtorContact } from '@/lib/db/debtors';
import { insertChatMessage, insertChatMessageTx } from '@/lib/db/chatMessages';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';
import { sendWhatsAppMessage, sendWhatsAppFileByUrl, WhatsAppError } from '@/lib/whatsapp';
import { interpolateTemplate } from '@/lib/whatsapp-template';
import { attachmentMessageType } from '@/lib/whatsapp-attachment';
import { logDebtorEvent, EVENT_TYPE_META } from '@/lib/debtor-events';

// Single source of truth for "send one WhatsApp message to one debtor and record
// it". Used by BOTH the single-send route (/api/whatsapp/send) and the bulk-send
// stream (/api/whatsapp/send-bulk) so the persistence/logging semantics — failed
// rows on the timeline, last_whatsapp_sent_at bump, WHATSAPP debtor event — can
// never drift between the two paths.

export interface SendAndRecordResult {
  ok: boolean;
  idMessage?: string;
  /** The chat_messages row id (success or recorded-failure) — lets the inbox
   *  reconcile its optimistic bubble with the canonical row. */
  messageId?: string;
  /** Set when the message was delivered but our bookkeeping transaction failed. */
  warning?: string;
  /** Set when the send itself failed (Hebrew detail). */
  error?: string;
}

export interface SendAndRecordArgs {
  debtor: DebtorContact;
  /** Recipient number in international form ("972XXXXXXXXX"). */
  phoneIntl: string;
  /** The raw template body (may contain {{name}} … placeholders). */
  rawMessage: string;
  /** Template id for the timeline metadata, or null for free text. */
  templateId: string | null;
  actor: Actor;
  /** The sending instance (Green id + token + host + our uuid). */
  creds: InstanceCreds;
  /** Optional single file attachment. When present the message is sent as media
   *  (Green API sendFileByUrl) with the text as the caption; the file url/name/
   *  mime/size are recorded on the chat_messages row for the history. */
  attachment?: {
    /** App-origin public URL (/api/public/wa-media/...) reachable by Green API. */
    url: string;
    /** Original (Hebrew) file name — shown to the recipient and in history. */
    name: string;
    mime: string;
    sizeBytes: number;
  } | null;
}

export async function sendAndRecordWhatsApp(args: SendAndRecordArgs): Promise<SendAndRecordResult> {
  const { debtor, phoneIntl, rawMessage, templateId, actor, creds } = args;
  const attachment = args.attachment ?? null;

  // Interpolate on the server with authoritative debtor data — the single source
  // of truth (the UI preview uses the very same interpolateTemplate()).
  const finalMessage = interpolateTemplate(rawMessage, debtor);
  const chatId = `${phoneIntl}@c.us`;

  // With a file, the text becomes the media caption (may be empty). Without one,
  // it's the message body. The chat_messages content column mirrors this.
  const caption = finalMessage.trim().length > 0 ? finalMessage : undefined;
  const messageType = attachment ? attachmentMessageType(attachment.name) : 'text';
  const storedContent = attachment ? (caption ?? null) : finalMessage;

  let idMessage: string;
  try {
    ({ idMessage } = attachment
      ? await sendWhatsAppFileByUrl({
          instanceId: creds.greenInstanceId,
          token: creds.token,
          apiUrl: creds.apiUrl,
          chatId,
          urlFile: attachment.url,
          fileName: attachment.name,
          ...(caption ? { caption } : {}),
        })
      : await sendWhatsAppMessage({
          instanceId: creds.greenInstanceId,
          token: creds.token,
          apiUrl: creds.apiUrl,
          chatId,
          message: finalMessage,
        }));
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    // Record the failed attempt (no external id, no last_whatsapp_sent_at, no
    // timeline event) so the failure is visible in the debtor's history.
    let failedId: string | null = null;
    try {
      failedId = await insertChatMessage({
        debtorId: debtor.id,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        messageType,
        content: storedContent,
        mediaUrl: attachment?.url ?? null,
        attachmentName: attachment?.name ?? null,
        attachmentMime: attachment?.mime ?? null,
        attachmentSize: attachment?.sizeBytes ?? null,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
        instanceId: creds.id,
      });
    } catch (logErr) {
      console.error('[whatsapp/send] failed to record failed message', logErr);
    }
    return { ok: false, error: detail, messageId: failedId ?? undefined };
  }

  // Success: persist the message, bump last_whatsapp_sent_at, and log a WHATSAPP
  // event on the unified timeline — all atomically.
  const actorName = actor.full_name || actor.username;
  let messageId: string | null = null;
  try {
    await withTransaction(async (client) => {
      messageId = await insertChatMessageTx(client, {
        debtorId: debtor.id,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: idMessage,
        direction: 'sent',
        messageType,
        content: storedContent,
        mediaUrl: attachment?.url ?? null,
        attachmentName: attachment?.name ?? null,
        attachmentMime: attachment?.mime ?? null,
        attachmentSize: attachment?.sizeBytes ?? null,
        status: 'sent',
        errorDetail: null,
        sentBy: actor.id,
        instanceId: creds.id,
      });

      await client.query(
        `update public.debtors set last_whatsapp_sent_at = now() where id = $1`,
        [debtor.id],
      );

      await logDebtorEvent(client, {
        debtorId: debtor.id,
        eventType: 'WHATSAPP',
        title: EVENT_TYPE_META.WHATSAPP.label,
        description: storedContent ?? `קובץ מצורף: ${attachment?.name ?? ''}`.trim(),
        metadata: {
          external_message_id: idMessage,
          chat_id: chatId,
          template_id: templateId,
          channel: 'green_api',
          ...(attachment
            ? { attachment_name: attachment.name, attachment_mime: attachment.mime, attachment_size: attachment.sizeBytes }
            : {}),
        },
        actor: { id: actor.id, name: actorName, email: actor.email },
      });
    });
  } catch (err) {
    // The message WAS delivered; only our bookkeeping failed. Report honestly.
    console.error('[whatsapp/send] post-send persistence failed', err);
    return { ok: true, idMessage, warning: 'ההודעה נשלחה אך תיעוד ההיסטוריה נכשל' };
  }

  return { ok: true, idMessage, messageId: messageId ?? undefined };
}

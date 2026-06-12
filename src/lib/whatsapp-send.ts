import 'server-only';
import type { Actor } from '@/lib/auth/actor';
import { withTransaction } from '@/lib/db';
import type { DebtorContact } from '@/lib/db/debtors';
import { insertChatMessage, insertChatMessageTx } from '@/lib/db/chatMessages';
import { sendWhatsAppMessage, WhatsAppError } from '@/lib/whatsapp';
import { interpolateTemplate } from '@/lib/whatsapp-template';
import { logDebtorEvent, EVENT_TYPE_META } from '@/lib/debtor-events';

// Single source of truth for "send one WhatsApp message to one debtor and record
// it". Used by BOTH the single-send route (/api/whatsapp/send) and the bulk-send
// stream (/api/whatsapp/send-bulk) so the persistence/logging semantics — failed
// rows on the timeline, last_whatsapp_sent_at bump, WHATSAPP debtor event — can
// never drift between the two paths.

export interface SendAndRecordResult {
  ok: boolean;
  idMessage?: string;
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
  instanceId: string;
  token: string;
}

export async function sendAndRecordWhatsApp(args: SendAndRecordArgs): Promise<SendAndRecordResult> {
  const { debtor, phoneIntl, rawMessage, templateId, actor, instanceId, token } = args;

  // Interpolate on the server with authoritative debtor data — the single source
  // of truth (the UI preview uses the very same interpolateTemplate()).
  const finalMessage = interpolateTemplate(rawMessage, debtor);
  const chatId = `${phoneIntl}@c.us`;

  let idMessage: string;
  try {
    ({ idMessage } = await sendWhatsAppMessage({ instanceId, token, chatId, message: finalMessage }));
  } catch (err) {
    const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
    // Record the failed attempt (no external id, no last_whatsapp_sent_at, no
    // timeline event) so the failure is visible in the debtor's history.
    try {
      await insertChatMessage({
        debtorId: debtor.id,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: null,
        direction: 'sent',
        content: finalMessage,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
      });
    } catch (logErr) {
      console.error('[whatsapp/send] failed to record failed message', logErr);
    }
    return { ok: false, error: detail };
  }

  // Success: persist the message, bump last_whatsapp_sent_at, and log a WHATSAPP
  // event on the unified timeline — all atomically.
  const actorName = actor.full_name || actor.username;
  try {
    await withTransaction(async (client) => {
      await insertChatMessageTx(client, {
        debtorId: debtor.id,
        contactPhone: phoneIntl,
        chatId,
        externalMessageId: idMessage,
        direction: 'sent',
        content: finalMessage,
        status: 'sent',
        errorDetail: null,
        sentBy: actor.id,
      });

      await client.query(
        `update public.debtors set last_whatsapp_sent_at = now() where id = $1`,
        [debtor.id],
      );

      await logDebtorEvent(client, {
        debtorId: debtor.id,
        eventType: 'WHATSAPP',
        title: EVENT_TYPE_META.WHATSAPP.label,
        description: finalMessage,
        metadata: {
          external_message_id: idMessage,
          chat_id: chatId,
          template_id: templateId,
          channel: 'green_api',
        },
        actor: { id: actor.id, name: actorName, email: actor.email },
      });
    });
  } catch (err) {
    // The message WAS delivered; only our bookkeeping failed. Report honestly.
    console.error('[whatsapp/send] post-send persistence failed', err);
    return { ok: true, idMessage, warning: 'ההודעה נשלחה אך תיעוד ההיסטוריה נכשל' };
  }

  return { ok: true, idMessage };
}

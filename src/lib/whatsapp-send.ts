import 'server-only';
import type { Actor } from '@/lib/auth/actor';
import { getDbPool, withTransaction } from '@/lib/db';
import type { DebtorContact } from '@/lib/db/debtors';
import { insertChatMessage, insertChatMessageTx } from '@/lib/db/chatMessages';
import {
  linkMessageAttachments,
  recordMessageAttachmentUrl,
  recordMessageAttachmentError,
  type MessageAttachment,
} from '@/lib/db/whatsappMessageAttachments';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';
import {
  sendWhatsAppMessage, sendWhatsAppFileByUrl, uploadWhatsAppFile, WhatsAppError,
} from '@/lib/whatsapp';
import { getObjectStream, buildProxyUrl, type PrivateBucket, PRIVATE_BUCKETS } from '@/lib/storage/server';
import { interpolateTemplate } from '@/lib/whatsapp-template';
import {
  attachmentMessageType, WHATSAPP_ATTACHMENT_LIMITS,
} from '@/lib/constants/whatsappAttachments';
import { hasUsableUrl, wireFileName } from '@/lib/wa-queue/attachments';
import { planMessageSends } from '@/lib/whatsapp-send-plan';
import { logDebtorEvent, EVENT_TYPE_META } from '@/lib/debtor-events';
import { logger } from '@/lib/logger';

// Single source of truth for "send one WhatsApp message to one debtor and record
// it". Used by BOTH the single-send route (/api/whatsapp/send) and the bulk-send
// stream (/api/whatsapp/send-bulk) so the persistence/logging semantics — failed
// rows on the timeline, last_whatsapp_sent_at bump, WHATSAPP debtor event — can
// never drift between the two paths.
//
// Attachments (up to WHATSAPP_MESSAGE_MAX_FILES) live in the PRIVATE
// whatsapp-attachments bucket. They reach the recipient the way a broadcast's do:
// the bytes are pushed to Green API's own storage (uploadFile, link valid 15
// days) and THAT link is what sendFileByUrl receives — we never publish a URL.
// The uploads run in parallel; the sends are sequential and ordered (text, then
// files — or a single file carrying the text as its caption). One file failing
// never cancels the others: its name comes back in `failedAttachments`.

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
  /** Original names of attachments that did not reach the recipient, when the
   *  rest of the message did. The caller answers 207 and names them. */
  failedAttachments?: string[];
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
  /** Staged wa_message_attachments rows, in send order. Empty = text only. */
  attachments?: MessageAttachment[];
}

function isPrivateBucket(b: string): b is PrivateBucket {
  return (PRIVATE_BUCKETS as readonly string[]).includes(b);
}

/** A file ready to be handed to Green API: its 15-day link plus the name the
 *  recipient sees. */
export interface ReadyFile {
  row: MessageAttachment;
  urlFile: string;
}

/** Makes sure every attachment has a Green API link, pushing the bytes of the
 *  ones that do not (or whose 15-day link has expired) in parallel. Returns what
 *  is ready to send and what could not be uploaded — never throws: a broken file
 *  must not cancel the message. Shared with the resend route. */
export async function ensureAttachmentLinks(
  attachments: MessageAttachment[],
  creds: InstanceCreds,
): Promise<{ ready: ReadyFile[]; failed: MessageAttachment[] }> {
  const settled = await Promise.all(attachments.map(async (row): Promise<ReadyFile | MessageAttachment> => {
    if (hasUsableUrl(row) && row.green_api_url) return { row, urlFile: row.green_api_url };
    try {
      const blob = await getObjectStream(row.bucket, row.object_key);
      if (!blob) throw new Error('הקובץ לא נמצא באחסון');
      const bytes = Buffer.from(await blob.arrayBuffer());
      const { urlFile } = await uploadWhatsAppFile({
        instanceId: creds.greenInstanceId,
        token: creds.token,
        apiUrl: creds.apiUrl,
        bytes,
        mimeType: row.mime_type,
        // Green reads the type from the extension; the key is ASCII, and webp
        // must be declared as png (Green's own FAQ workaround).
        fileName: wireFileName(row.object_key),
      });
      await recordMessageAttachmentUrl(row.id, urlFile, WHATSAPP_ATTACHMENT_LIMITS.greenApiUrlLifetimeDays)
        .catch((err) => logger.error('[whatsapp/send] failed to record attachment url', err));
      return { row, urlFile };
    } catch (err) {
      const detail = err instanceof WhatsAppError ? err.message : (err as Error).message;
      logger.error('[whatsapp/send] attachment upload failed', { attachmentId: row.id, detail });
      await recordMessageAttachmentError(row.id, detail).catch(() => { /* best-effort */ });
      return row;
    }
  }));

  const ready: ReadyFile[] = [];
  const failed: MessageAttachment[] = [];
  for (const r of settled) {
    if ('urlFile' in r) ready.push(r);
    else failed.push(r);
  }
  return { ready, failed };
}

export async function sendAndRecordWhatsApp(args: SendAndRecordArgs): Promise<SendAndRecordResult> {
  const { debtor, phoneIntl, rawMessage, templateId, actor, creds } = args;
  const attachments = args.attachments ?? [];

  // Interpolate on the server with authoritative debtor data — the single source
  // of truth (the UI preview uses the very same interpolateTemplate()).
  const finalMessage = interpolateTemplate(rawMessage, debtor);
  const chatId = `${phoneIntl}@c.us`;

  // Push every file to Green API first (in parallel). Files that fail here are
  // reported by name; the rest of the message still goes out.
  const { ready, failed } = attachments.length
    ? await ensureAttachmentLinks(attachments, creds)
    : { ready: [] as ReadyFile[], failed: [] as MessageAttachment[] };
  const failedNames = failed.map((f) => f.original_name);

  // Everything that was attached failed to upload and there is nothing to say:
  // refuse rather than send an empty message.
  if (attachments.length > 0 && ready.length === 0 && finalMessage.trim().length === 0) {
    return { ok: false, error: 'העלאת הקבצים נכשלה, ההודעה לא נשלחה', failedAttachments: failedNames };
  }

  const steps = planMessageSends(finalMessage, ready.length);
  const first = ready[0]?.row ?? null;
  // The parent row keeps the legacy single-file columns (first file) so the
  // existing history renderers and the resend fallback keep working; the
  // wa_message_attachments rows are the source of truth for the full set.
  const messageType = first ? attachmentMessageType(first.original_name) : 'text';
  // The row's content is the text the recipient saw — as a caption on a single
  // file, or as its own message — and null when only files went out.
  const storedContent = finalMessage.trim().length > 0 ? finalMessage : null;
  const firstUrl = first && isPrivateBucket(first.bucket) ? buildProxyUrl(first.bucket, first.object_key) : null;

  // Send in order. The FIRST step's Green id identifies the message row; a file
  // that fails after the message is under way is reported, not fatal.
  let idMessage: string | null = null;
  // Keyed by attachment id: two files may legitimately share a name.
  const failedIds = new Set(failed.map((f) => f.id));
  let lastSendError: unknown = null;
  try {
    for (const step of steps) {
      if (step.kind === 'text') {
        const res = await sendWhatsAppMessage({
          instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
          chatId, message: finalMessage,
        });
        idMessage ??= res.idMessage;
        continue;
      }
      const file = ready[step.index];
      try {
        const res = await sendWhatsAppFileByUrl({
          instanceId: creds.greenInstanceId, token: creds.token, apiUrl: creds.apiUrl,
          chatId,
          urlFile: file.urlFile,
          fileName: wireFileName(file.row.original_name),
          ...(step.caption ? { caption: step.caption } : {}),
        });
        idMessage ??= res.idMessage;
      } catch (err) {
        // A single file that Green refused — keep going with the rest.
        const detail = err instanceof WhatsAppError ? err.message : 'שגיאה לא ידועה';
        logger.error('[whatsapp/send] file send failed', { attachmentId: file.row.id, detail });
        await recordMessageAttachmentError(file.row.id, detail).catch(() => { /* best-effort */ });
        failedIds.add(file.row.id);
        lastSendError = err;
      }
    }
    // Nothing at all reached the recipient (every step failed, or there were no
    // steps): that is a failed send, not a partial one — never record it as sent.
    if (!idMessage) throw lastSendError ?? new WhatsAppError('ההודעה לא נשלחה');
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
        mediaUrl: firstUrl,
        attachmentName: first?.original_name ?? null,
        attachmentMime: first?.mime_type ?? null,
        attachmentSize: first?.size_bytes ?? null,
        status: 'failed',
        errorDetail: detail,
        sentBy: actor.id,
        instanceId: creds.id,
      });
      // Keep the files with the row so the resend can send them again.
      if (failedId && attachments.length) {
        await linkMessageAttachments(
          getDbPool(), failedId, attachments.map((a) => a.id), actor.id,
        ).catch((e) => logger.error('[whatsapp/send] linking attachments to failed row failed', e));
      }
    } catch (logErr) {
      logger.error('[whatsapp/send] failed to record failed message', logErr);
    }
    const names = attachments.filter((a) => failedIds.has(a.id)).map((a) => a.original_name);
    return { ok: false, error: detail, messageId: failedId ?? undefined, failedAttachments: names.length ? names : undefined };
  }

  // Success: persist the message, bump last_whatsapp_sent_at, and log a WHATSAPP
  // event on the unified timeline — all atomically.
  const actorName = actor.full_name || actor.username;
  const deliveredNames = ready.filter((r) => !failedIds.has(r.row.id)).map((r) => r.row.original_name);
  const failedSendNames = attachments.filter((a) => failedIds.has(a.id)).map((a) => a.original_name);
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
        mediaUrl: firstUrl,
        attachmentName: first?.original_name ?? null,
        attachmentMime: first?.mime_type ?? null,
        attachmentSize: first?.size_bytes ?? null,
        status: 'sent',
        errorDetail: null,
        sentBy: actor.id,
        instanceId: creds.id,
      });

      // Every attachment of this message — delivered or not — belongs to the row.
      if (messageId && attachments.length) {
        await linkMessageAttachments(client, messageId, attachments.map((a) => a.id), actor.id);
      }

      await client.query(
        `update public.debtors set last_whatsapp_sent_at = now() where id = $1`,
        [debtor.id],
      );

      await logDebtorEvent(client, {
        debtorId: debtor.id,
        eventType: 'WHATSAPP',
        title: EVENT_TYPE_META.WHATSAPP.label,
        description: storedContent ?? `קבצים מצורפים: ${deliveredNames.join(', ')}`.trim(),
        metadata: {
          external_message_id: idMessage,
          chat_id: chatId,
          template_id: templateId,
          channel: 'green_api',
          ...(deliveredNames.length ? { attachments: deliveredNames } : {}),
          ...(failedSendNames.length ? { attachments_failed: failedSendNames } : {}),
        },
        actor: { id: actor.id, name: actorName, email: actor.email },
      });
    });
  } catch (err) {
    // The message WAS delivered; only our bookkeeping failed. Report honestly.
    logger.error('[whatsapp/send] post-send persistence failed', err);
    return { ok: true, idMessage: idMessage ?? undefined, warning: 'ההודעה נשלחה אך תיעוד ההיסטוריה נכשל' };
  }

  return {
    ok: true,
    idMessage: idMessage ?? undefined,
    messageId: messageId ?? undefined,
    ...(failedSendNames.length ? { failedAttachments: failedSendNames } : {}),
  };
}

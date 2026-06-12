import 'server-only';
import { queryOne } from '@/lib/db';
import { insertChatMessage } from '@/lib/db/chatMessages';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';
import { emitWa } from '@/lib/whatsapp-events';
import type { ThreadMessage } from '@/types/whatsapp';
import {
  getIncomingMessages,
  parseLastIncomingItem,
  phoneDigitsKey,
  type ParsedIncoming,
  type ParsedOutgoing,
} from '@/lib/whatsapp';

/** ISO timestamp from a Green API unix-seconds value, or now. */
function isoFromUnix(ts: number | null): string {
  return new Date(ts ? ts * 1000 : Date.now()).toISOString();
}

// Inbound message handling (phase 2). Both the live webhook and the
// lastIncomingMessages pull funnel through processIncomingMessage(), so the
// dedup + debtor cross-reference + insert behave identically and a double run is
// safe (ON CONFLICT (external_message_id) DO NOTHING).

/**
 * Match a received sender to a debtor by the NORMALIZED phone key (last 9
 * digits, non-digits stripped on both sides). This unifies the local "0…" form
 * an inbound message carries with a debtor field that may be stored as "0…",
 * "972…" or formatted — the old exact `phone_owner = $1` match silently missed
 * those, leaving conversations unlinked (and thus unsearchable by name).
 */
async function findDebtorIdByPhone(localPhone: string): Promise<string | null> {
  const key = phoneDigitsKey(localPhone);
  if (!key) return null;
  const row = await queryOne<{ id: string }>(
    `select id from public.debtors
      where right(regexp_replace(coalesce(phone_owner,''),  '[^0-9]', '', 'g'), 9) = $1
         or right(regexp_replace(coalesce(phone_tenant,''), '[^0-9]', '', 'g'), 9) = $1
      order by is_archived asc, created_at asc
      limit 1`,
    [key],
  );
  return row?.id ?? null;
}

export type ProcessResult = 'inserted' | 'duplicate';

/**
 * Store one normalised inbound message: cross-reference the sender to a debtor
 * (linked / unlinked) and insert with idempotent dedup. Returns 'duplicate' when
 * the message was already stored (ON CONFLICT suppressed the insert).
 */
export async function processIncomingMessage(
  parsed: ParsedIncoming,
  instanceId: string | null = null,
): Promise<ProcessResult> {
  // Groups (…@g.us) are one conversation keyed on the group id, never matched to
  // a single debtor — the sender's phone is still kept for reference.
  const debtorId = parsed.isGroup ? null : await findDebtorIdByPhone(parsed.senderPhoneLocal);

  const id = await insertChatMessage({
    debtorId,
    contactPhone: parsed.senderPhoneLocal,
    chatId: parsed.chatId,
    externalMessageId: parsed.externalMessageId,
    direction: 'received',
    messageType: parsed.messageType,
    linkStatus: debtorId ? 'linked' : 'unlinked',
    content: parsed.content,
    // For media messages content holds the Green API downloadUrl; mirror it into
    // media_url so the inbox can render it as media, not a raw link.
    mediaUrl: parsed.messageType === 'text' ? null : parsed.content,
    status: 'sent', // inbound = already delivered; the status column is only meaningful for outbound
    errorDetail: null,
    sentBy: null,
    instanceId,
    createdAtUnix: parsed.timestamp,
  });

  // Push to open inboxes the instant it's stored (only on a real insert — a
  // duplicate must not re-notify).
  if (id && instanceId) {
    const message: ThreadMessage = {
      id,
      debtor_id: debtorId,
      contact_phone: parsed.senderPhoneLocal,
      chat_id: parsed.chatId,
      external_message_id: parsed.externalMessageId,
      link_status: debtorId ? 'linked' : 'unlinked',
      direction: 'received',
      message_type: parsed.messageType,
      content: parsed.content,
      media_url: parsed.messageType === 'text' ? null : parsed.content,
      status: 'sent',
      error_detail: null,
      sent_by: null,
      sent_by_name: null,
      broadcast_id: null,
      read_at: null,
      created_at: isoFromUnix(parsed.timestamp),
    };
    emitWa({ type: 'message_received', instance_id: instanceId, chat_id: parsed.chatId, message });
  }

  return id ? 'inserted' : 'duplicate';
}

/**
 * Store an outbound message reported by the webhook (sent from the phone, or the
 * API echo). Mirrors processIncomingMessage but direction='sent'. Dedup by
 * external_message_id makes the API echo of a message we already stored a no-op.
 */
export async function processOutgoingMessage(
  parsed: ParsedOutgoing,
  instanceId: string | null = null,
): Promise<ProcessResult> {
  const debtorId = await findDebtorIdByPhone(parsed.recipientPhoneLocal);

  const id = await insertChatMessage({
    debtorId,
    contactPhone: parsed.recipientPhoneLocal,
    chatId: parsed.chatId,
    externalMessageId: parsed.externalMessageId,
    direction: 'sent',
    messageType: parsed.messageType,
    linkStatus: 'linked', // outbound — never surfaced in the unlinked inbox
    content: parsed.content,
    mediaUrl: parsed.messageType === 'text' ? null : parsed.content,
    status: 'sent',
    errorDetail: null,
    sentBy: null,
    instanceId,
    createdAtUnix: parsed.timestamp,
  });

  if (id && instanceId) {
    const message: ThreadMessage = {
      id,
      debtor_id: debtorId,
      contact_phone: parsed.recipientPhoneLocal,
      chat_id: parsed.chatId,
      external_message_id: parsed.externalMessageId,
      link_status: 'linked',
      direction: 'sent',
      message_type: parsed.messageType,
      content: parsed.content,
      media_url: parsed.messageType === 'text' ? null : parsed.content,
      status: 'sent',
      error_detail: null,
      sent_by: null,
      sent_by_name: null,
      broadcast_id: null,
      read_at: null,
      created_at: isoFromUnix(parsed.timestamp),
    };
    emitWa({ type: 'message_sent', instance_id: instanceId, chat_id: parsed.chatId, message });
  }

  return id ? 'inserted' : 'duplicate';
}

export interface PullResult {
  received: number;
  skipped: number;
}

/**
 * Proactive fallback for when a live webhook missed messages: pull the last
 * `minutes` of incoming messages from Green API and run each through the SAME
 * processIncomingMessage() the webhook uses. Dedup makes this safe to re-run.
 * `received` = newly stored; `skipped` = duplicates + unparseable items.
 */
export async function pullGreenApiMessages(creds: InstanceCreds, minutes = 1440): Promise<PullResult> {
  const items = await getIncomingMessages({
    instanceId: creds.greenInstanceId,
    token: creds.token,
    apiUrl: creds.apiUrl,
    minutes,
  });

  let received = 0;
  let skipped = 0;
  for (const item of items) {
    const parsed = parseLastIncomingItem(item);
    if (!parsed) {
      skipped++;
      continue;
    }
    try {
      const r = await processIncomingMessage(parsed, creds.id);
      if (r === 'inserted') received++;
      else skipped++;
    } catch (err) {
      console.error('[whatsapp/pull] failed to process a message', err);
      skipped++;
    }
  }
  return { received, skipped };
}

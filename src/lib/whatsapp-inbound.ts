import 'server-only';
import { queryOne } from '@/lib/db';
import { insertChatMessage } from '@/lib/db/chatMessages';
import { getGreenApiSettings } from '@/lib/db/greenApiSettings';
import {
  getIncomingMessages,
  parseLastIncomingItem,
  phoneDigitsKey,
  type ParsedIncoming,
  type ParsedOutgoing,
} from '@/lib/whatsapp';

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
export async function processIncomingMessage(parsed: ParsedIncoming): Promise<ProcessResult> {
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
    createdAtUnix: parsed.timestamp,
  });

  return id ? 'inserted' : 'duplicate';
}

/**
 * Store an outbound message reported by the webhook (sent from the phone, or the
 * API echo). Mirrors processIncomingMessage but direction='sent'. Dedup by
 * external_message_id makes the API echo of a message we already stored a no-op.
 */
export async function processOutgoingMessage(parsed: ParsedOutgoing): Promise<ProcessResult> {
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
    createdAtUnix: parsed.timestamp,
  });

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
export async function pullGreenApiMessages(minutes = 1440): Promise<PullResult> {
  const { instanceId, token } = await getGreenApiSettings();
  const items = await getIncomingMessages({ instanceId, token, minutes });

  let received = 0;
  let skipped = 0;
  for (const item of items) {
    const parsed = parseLastIncomingItem(item);
    if (!parsed) {
      skipped++;
      continue;
    }
    try {
      const r = await processIncomingMessage(parsed);
      if (r === 'inserted') received++;
      else skipped++;
    } catch (err) {
      console.error('[whatsapp/pull] failed to process a message', err);
      skipped++;
    }
  }
  return { received, skipped };
}

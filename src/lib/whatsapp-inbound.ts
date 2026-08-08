import 'server-only';
import { queryOne } from '@/lib/db';
import { insertChatMessage } from '@/lib/db/chatMessages';
import { findSupplierIdByPhone } from '@/lib/db/suppliers';
import type { InstanceCreds } from '@/lib/db/whatsappInstances';
import { emitWa } from '@/lib/whatsapp-events';
import { listActiveAdmins } from '@/lib/db/users';
import { createNotification } from '@/services/notifications';
import { todayInJerusalem } from '@/lib/dates';
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
    `select d.id from public.debtors d
      -- resident identity from contacts (registry); debtors columns are frozen legacy fallback (no linked contact only)
      left join public.contacts rc on rc.id = d.contact_id
      where right(regexp_replace(coalesce(case when rc.id is null then d.phone_owner  else rc.owner_phone  end, ''), '[^0-9]', '', 'g'), 9) = $1
         or right(regexp_replace(coalesce(case when rc.id is null then d.phone_tenant else rc.tenant_phone end, ''), '[^0-9]', '', 'g'), 9) = $1
      order by d.is_archived asc, d.created_at asc
      limit 1`,
    [key],
  );
  return row?.id ?? null;
}

/** Debtor display name for the notification copy — owner first, then tenant,
 *  then apartment, else null (caller falls back to the phone). */
async function getDebtorDisplayName(debtorId: string): Promise<string | null> {
  const row = await queryOne<{ owner_name: string | null; tenant_name: string | null; apartment_number: string | null }>(
    `select
        case when rc.id is null then d.owner_name  else rc.owner_name  end as owner_name,
        case when rc.id is null then d.tenant_name else rc.tenant_name end as tenant_name,
        d.apartment_number
       from public.debtors d
       -- resident identity from contacts (registry); debtors columns are frozen legacy fallback (no linked contact only)
       left join public.contacts rc on rc.id = d.contact_id
      where d.id = $1
      limit 1`,
    [debtorId],
  );
  if (!row) return null;
  const owner = row.owner_name?.trim();
  const tenant = row.tenant_name?.trim();
  if (owner) return owner;
  if (tenant) return tenant;
  return row.apartment_number ? `דירה ${row.apartment_number}` : null;
}

/**
 * Notify active admins (super_admin + admin) of an inbound WhatsApp message.
 * Anti-flood: dedupe per CONTACT-per-DAY so a debtor who sends ten messages
 * produces ONE notification per admin that day (createNotification's
 * ON CONFLICT(dedupe_key) DO NOTHING enforces it). Best-effort — never throws.
 */
async function notifyAdminsOfInbound(parsed: ParsedIncoming, debtorId: string | null, messageId: string): Promise<void> {
  try {
    const name = debtorId ? await getDebtorDisplayName(debtorId) : null;
    const contactLabel = name ?? parsed.senderPhoneLocal;
    // Per-Israel-day bucket (not UTC) so evening messages don't split/merge
    // across the UTC midnight rollover.
    const today = todayInJerusalem();
    const dedupeContact = debtorId ?? parsed.senderPhoneLocal;

    const admins = await listActiveAdmins();
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        type: 'whatsapp_message_received',
        title: 'הודעת WhatsApp חדשה',
        message: `הודעה מ-${contactLabel}`,
        sourceModule: 'whatsapp',
        sourceEntityType: 'chat_message',
        sourceEntityId: messageId,
        actionUrl: '/messages',
        dedupeKey: `whatsapp_message_received:${dedupeContact}:${admin.id}:${today}`,
      });
    }
  } catch (err) {
    console.error('[whatsapp-inbound] admin notification failed', err);
  }
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
  // Cross-reference order: debtor first, supplier second, else unlinked. Only
  // probe suppliers when no debtor matched (XOR — a conversation is one or the
  // other). This is what makes "create supplier from this number" stick: future
  // inbound from that number auto-links to the supplier.
  const supplierId =
    !parsed.isGroup && !debtorId ? await findSupplierIdByPhone(parsed.senderPhoneLocal) : null;

  const id = await insertChatMessage({
    debtorId,
    supplierId,
    contactPhone: parsed.senderPhoneLocal,
    chatId: parsed.chatId,
    externalMessageId: parsed.externalMessageId,
    direction: 'received',
    messageType: parsed.messageType,
    linkStatus: debtorId || supplierId ? 'linked' : 'unlinked',
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
      supplier_id: supplierId,
      contact_phone: parsed.senderPhoneLocal,
      chat_id: parsed.chatId,
      external_message_id: parsed.externalMessageId,
      link_status: debtorId || supplierId ? 'linked' : 'unlinked',
      direction: 'received',
      message_type: parsed.messageType,
      content: parsed.content,
      media_url: parsed.messageType === 'text' ? null : parsed.content,
      status: 'sent',
      error_detail: null,
      sent_by: null,
      sent_by_name: null,
      supplier_display_name: null,
      broadcast_id: null,
      read_at: null,
      created_at: isoFromUnix(parsed.timestamp),
    };
    emitWa({ type: 'message_received', instance_id: instanceId, chat_id: parsed.chatId, message });
  }

  // Notify staff of the inbound message. Fire-and-forget so the webhook responds
  // immediately (Green API retries on slow ACKs); only on a REAL insert — a
  // duplicate must never re-notify. Outbound messages never reach here.
  if (id) {
    void notifyAdminsOfInbound(parsed, debtorId, id);
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
  // Debtor first, supplier second — mirror the inbound cross-reference so an
  // outbound row to a supplier's number carries the supplier link too.
  const supplierId = !debtorId ? await findSupplierIdByPhone(parsed.recipientPhoneLocal) : null;

  const id = await insertChatMessage({
    debtorId,
    supplierId,
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
      supplier_id: supplierId,
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
      supplier_display_name: null,
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

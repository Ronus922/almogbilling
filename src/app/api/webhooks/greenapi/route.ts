import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
  parseWebhookNotificationFull,
  parseOutgoingStatus,
  parseOutgoingMessage,
  parseStateInstanceChanged,
  webhookInstanceId,
} from '@/lib/whatsapp';
import { processIncomingMessage, processOutgoingMessage } from '@/lib/whatsapp-inbound';
import { updateMessageStatusByExternalId } from '@/lib/db/chatMessages';
import { getDbPool } from '@/lib/db';
import { markRecipientDelivery } from '@/lib/wa-queue/campaigns';
import { emitWa } from '@/lib/whatsapp-events';
import {
  getInstanceByGreenId,
  updateInstanceState,
  type InstanceState,
} from '@/lib/db/whatsappInstances';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KNOWN_STATES: readonly InstanceState[] = [
  'notAuthorized', 'authorized', 'blocked', 'starting', 'yellowCard', 'sleepMode',
];

// POST /api/webhooks/greenapi?secret=… — PUBLIC (no session). The canonical
// Green API inbound webhook for the messaging module. Authenticated by a shared
// `secret` query param compared (constant-time) against GREEN_API_WEBHOOK_SECRET.
//
// Handles, by typeWebhook:
//   • incomingMessageReceived   → store inbound (person + groups, debtor match)
//   • outgoingMessageStatus     → update an outbound row's status (delivered/read)
//   • outgoingAPIMessageReceived / outgoingMessageReceived
//                               → store/echo an outbound message (sent from phone)
//
// Hard rules:
//   • Wrong / missing secret → 401, no body.
//   • ALWAYS 200 on authenticated calls (even unknown types) so Green API never
//     queues retries; failures are logged internally. Dedup is downstream
//     (ON CONFLICT external_message_id DO NOTHING).

function secretMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expected = process.env.GREEN_API_WEBHOOK_SECRET ?? '';
  const provided = req.nextUrl.searchParams.get('secret') ?? '';
  if (!secretMatches(provided, expected)) {
    return new NextResponse(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // Malformed body — ack so Green API stops retrying.
    return NextResponse.json({ ok: true });
  }

  // Identify the receiving instance from instanceData.idInstance. Every inbound /
  // status / state notification is attributed to ONE employee's instance.
  const greenId = webhookInstanceId(payload);
  const typeWebhook =
    typeof (payload as { typeWebhook?: unknown })?.typeWebhook === 'string'
      ? (payload as { typeWebhook: string }).typeWebhook
      : 'unknown';

  const instance = greenId ? await getInstanceByGreenId(greenId) : null;
  // One-line audit of every notification (typeWebhook + idInstance + resolved row).
  console.info(
    `[webhooks/greenapi] type=${typeWebhook} idInstance=${greenId ?? '—'} instance=${instance?.id ?? 'UNKNOWN'}`,
  );

  if (!instance) {
    // A notification for an instance we don't manage (a freshly-created instance
    // whose row hasn't been saved, or a stale registration). Warn + ack.
    console.warn(`[webhooks/greenapi] notification for unknown instance idInstance=${greenId ?? '—'} (type=${typeWebhook})`);
    return NextResponse.json({ ok: true });
  }

  try {
    const incoming = parseWebhookNotificationFull(payload);
    if (incoming) {
      await processIncomingMessage(incoming, instance.id);
      return NextResponse.json({ ok: true });
    }

    const status = parseOutgoingStatus(payload);
    if (status) {
      const { matched, advanced } = await updateMessageStatusByExternalId(status.externalMessageId, status.status);
      // Durable broadcasts don't write chat_messages rows — mirror delivered/read
      // onto the campaign recipient instead (matched by provider_message_id).
      if (status.status === 'delivered' || status.status === 'read') {
        await markRecipientDelivery(getDbPool(), status.externalMessageId, status.status);
      }
      if (advanced) {
        // Push the ✓ update to open inboxes (the bubble matches by external id).
        emitWa({
          type: 'message_status',
          instance_id: instance.id,
          external_message_id: status.externalMessageId,
          status: status.status,
        });
      }
      if (!matched) {
        // A status arrived for a message we have NO record of (sent from the
        // phone before inbound storage, or a stale id). Warn so a systemic
        // "statuses never reach us" problem is visible — but NOT on the duplicate
        // / out-of-order status webhooks Green API routinely re-delivers for a
        // known message (those are matched-but-not-advanced, and are normal).
        console.warn(
          `[webhooks/greenapi] outgoing status '${status.status}' for unknown message ${status.externalMessageId}`,
        );
      }
      return NextResponse.json({ ok: true });
    }

    const outgoing = parseOutgoingMessage(payload);
    if (outgoing) {
      await processOutgoingMessage(outgoing, instance.id);
      return NextResponse.json({ ok: true });
    }

    // Connection state change — keep the per-employee state badge fresh.
    const newState = parseStateInstanceChanged(payload);
    if (newState && (KNOWN_STATES as readonly string[]).includes(newState)) {
      await updateInstanceState(instance.id, newState as InstanceState);
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    console.error('[webhooks/greenapi] processing failed', err);
  }

  // Unknown / unsupported notification — acknowledge and ignore.
  return NextResponse.json({ ok: true });
}

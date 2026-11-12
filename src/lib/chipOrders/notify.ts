import 'server-only';
import { getDbPool } from '@/lib/db';
import { appUrl } from '@/lib/config';
import { logger } from '@/lib/logger';
import { renderTemplate } from '@/lib/email-templates';
import { sendWithRetry } from '@/lib/email/send';
import { sendWhatsAppMessage } from '@/lib/whatsapp';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { DEFAULT_WA_RATE_PER_MIN, takeWindowSlot } from '@/lib/wa-queue/rate-limit';
import { e164ToChatId } from '@/lib/portal/phone';
import { getChipOrderSettings } from '@/lib/db/appSettings';
import { getOrderForNotify, recordChipOrderNotification } from '@/lib/db/chipOrders';
import { chipOrderMessage, chipOrderWhatsAppText } from './messages';
import type { ChipOrderNotifyKind } from './model';

// A chip-order status message to the person who ordered, on BOTH channels:
// email through the SMTP account of the settings (sendWithRetry), WhatsApp
// through the building's Green API instance (the same system-send creds the
// portal OTP uses), inside that instance's shared rate window (12 / minute,
// with broadcasts and the debtors' bulk send). The channels are independent:
// one failing never stops the other, and nothing here throws — every outcome
// (sent / failed / skipped) is a row on the order, shown on its screen.
//
// Callers run this in after() so the status change answers at once; the wait
// for a WhatsApp slot is capped so a stuck window cannot hold a request open.

const WA_WAIT_CAP_MS = 5 * 60_000;

export function chipOrderTrackUrl(token: string): string {
  return `${appUrl()}/chip-order/track/${token}`;
}

export function formatDueText(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

async function viaEmail(orderId: string, kind: ChipOrderNotifyKind, to: string, rendered: { subject: string; html: string; text: string }) {
  try {
    await sendWithRetry({ to, subject: rendered.subject, html: rendered.html, text: rendered.text });
    await recordChipOrderNotification({ orderId, kind, channel: 'email', status: 'sent' });
  } catch (err) {
    const error = (err as Error).message || 'email_failed';
    logger.warn('[chip-orders] email failed', { orderId, kind, error });
    await recordChipOrderNotification({ orderId, kind, channel: 'email', status: 'failed', error });
  }
}

async function viaWhatsApp(orderId: string, kind: ChipOrderNotifyKind, phoneE164: string, text: string) {
  try {
    const creds = await getDefaultSendCreds();
    if (!creds) {
      await recordChipOrderNotification({ orderId, kind, channel: 'whatsapp', status: 'skipped', error: 'לא מחובר מספר וואטסאפ' });
      return;
    }
    const deadline = Date.now() + WA_WAIT_CAP_MS;
    const slot = await takeWindowSlot(getDbPool(), creds.id, DEFAULT_WA_RATE_PER_MIN, {
      aborted: () => Date.now() > deadline,
    });
    if (!slot) {
      await recordChipOrderNotification({ orderId, kind, channel: 'whatsapp', status: 'failed', error: 'חלון הקצב של מספר הוואטסאפ מלא — לא נשלח' });
      return;
    }
    await sendWhatsAppMessage({
      instanceId: creds.greenInstanceId,
      token: creds.token,
      apiUrl: creds.apiUrl,
      chatId: e164ToChatId(phoneE164),
      message: text,
    });
    await recordChipOrderNotification({ orderId, kind, channel: 'whatsapp', status: 'sent' });
  } catch (err) {
    const error = (err as Error).message || 'whatsapp_failed';
    logger.warn('[chip-orders] whatsapp failed', { orderId, kind, error });
    await recordChipOrderNotification({ orderId, kind, channel: 'whatsapp', status: 'failed', error }).catch(() => {});
  }
}

export async function notifyChipOrder(orderId: string, kind: ChipOrderNotifyKind): Promise<void> {
  try {
    const order = await getOrderForNotify(orderId);
    if (!order) return;
    const settings = kind === 'ready' ? await getChipOrderSettings() : null;
    const msg = chipOrderMessage({
      kind,
      fullName: order.full_name,
      orderNumber: order.order_number,
      apartments: order.apartments,
      trackUrl: chipOrderTrackUrl(order.tracking_token),
      dueText: formatDueText(order.due_at),
      pickupText: settings?.pickupText ?? null,
      rejectReason: order.reject_reason,
      refundStatus: order.refund_status,
      invoiceUrl: order.invoice_url,
    });
    await Promise.allSettled([
      viaEmail(orderId, kind, order.email, renderTemplate('chip-order', msg)),
      viaWhatsApp(orderId, kind, order.phone_e164, chipOrderWhatsAppText(msg)),
    ]);
  } catch (err) {
    logger.error('[chip-orders] notify failed', { orderId, kind, err });
  }
}

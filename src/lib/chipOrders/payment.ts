import 'server-only';
import { logger } from '@/lib/logger';
import { writeAudit } from '@/lib/db/audit';
import { getOrderPaymentRef, markChipOrderPaid } from '@/lib/db/chipOrders';
import { findPaidTransaction, getPaymentProcessInfo } from '@/lib/grow/client';
import { notifyChipOrder } from './notify';

// The ONE place an order becomes "paid": Grow's own API (getPaymentProcessInfo
// with OUR stored process) must show a transaction with statusCode 2 and
// exactly the order's total. Two callers: Grow's server callback (notify
// route), and — as a fallback when that callback is late or blocked — the
// tracking page right after the payment iframe reported success (?paid=1),
// throttled by its caller.

/** Who saw the payment: Grow's callback, the tracking page's fallback, the
 *  hourly purge (an "unpaid" order Grow says WAS paid), or — for a test order,
 *  which never touches Grow — the "סיים הזמנת בדיקה" button. */
export type PaymentSource = 'grow_callback' | 'track_page' | 'purge' | 'test_finish';

export type PaymentCheck =
  | { kind: 'paid'; transitioned: boolean }
  | { kind: 'not_paid' }
  | { kind: 'unknown_order' }
  | { kind: 'error'; message: string };

export async function confirmChipOrderPayment(orderId: string, source: PaymentSource): Promise<PaymentCheck> {
  const order = await getOrderPaymentRef(orderId);
  if (!order || !order.grow_process_id || !order.grow_process_token) return { kind: 'unknown_order' };
  if (order.status !== 'pending_payment') return { kind: 'paid', transitioned: false };

  let paid;
  try {
    const info = await getPaymentProcessInfo(order.grow_process_id, order.grow_process_token);
    paid = findPaidTransaction(info.transactions, order.total);
  } catch (e) {
    const message = (e as Error).message;
    logger.error('[chip-order] grow verification failed', { orderId, source, error: message });
    return { kind: 'error', message };
  }
  if (!paid) return { kind: 'not_paid' };

  const transitioned = await markChipOrderPaid(orderId, {
    transactionId: paid.transactionId,
    transactionToken: paid.transactionToken,
    asmachta: paid.asmachta,
  });
  return { kind: 'paid', transitioned };
}

/** What follows the transition to paid — the audit row and the "received &
 *  paid" message (email + WhatsApp). Run it in after(). */
export async function afterChipOrderPaid(orderId: string, source: PaymentSource): Promise<void> {
  await writeAudit({
    actorUserId: null,
    action: 'paid',
    entityType: 'chip_order',
    entityId: orderId,
    metadata: { source },
  });
  await notifyChipOrder(orderId, 'paid');
}

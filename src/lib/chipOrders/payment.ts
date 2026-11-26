import 'server-only';
import { writeAudit } from '@/lib/db/audit';
import { notifyChipOrder } from './notify';

// What follows "סיים הזמנת בדיקה" — the payment step of a TEST order while the
// sandbox is not configured (CI). A card payment writes its own audit row in
// the transaction that marks the order paid (src/lib/db/chipOrderCard.ts), so
// only this path needs one here.

export type PaymentSource = 'test_finish';

/** The audit row and the "received & paid" message (email + WhatsApp). Run it in after(). */
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

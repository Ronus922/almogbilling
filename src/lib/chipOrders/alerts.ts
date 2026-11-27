import 'server-only';
import { logger } from '@/lib/logger';
import { listActiveAdmins } from '@/lib/db/users';
import { createNotification } from '@/services/notifications';

// "Ronen must look at this" — the alert channel of chip-order payments
// (26/11/2026): the existing notifications (bell + email per the user's
// preferences, type chip_order_alert) to EVERY active admin / super admin.
// Used for what needs a person: a Morning document that failed for good, a
// charge that does not fit its order (twice, wrong amount, wrong environment,
// no session), a refund PayPlus reported that matches nothing. Deduped by key
// per admin; never throws.

export async function alertChipOrderAdmins(a: {
  orderId: string | null;
  title: string;
  message: string;
  /** One alert per thing, ever (per admin). */
  dedupeKey: string;
}): Promise<void> {
  try {
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      await createNotification({
        userId: admin.id,
        type: 'chip_order_alert',
        title: a.title.slice(0, 120),
        message: a.message.slice(0, 400),
        sourceModule: 'chips',
        sourceEntityType: a.orderId ? 'chip_order' : undefined,
        sourceEntityId: a.orderId ?? undefined,
        actionUrl: '/chips',
        priority: 'high',
        dedupeKey: `${a.dedupeKey}:${admin.id}`,
      });
    }
  } catch (err) {
    logger.error('[chip-orders] admin alert failed', { key: a.dedupeKey, err: (err as Error).name });
  }
}

import 'server-only';
import { createNotification } from '@/lib/db/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import { claimSmtpAuthAlertSlot } from '@/lib/db/appSettings';
import { DEFAULT_TITLE } from '@/lib/notifications/registry';

export const SMTP_AUTH_ALERT_MESSAGE =
  'שליחת מייל נכשלה — אימות SMTP נדחה. יש לעדכן App Password בהגדרות מייל';

/**
 * Bell-only alert to every active super_admin / admin: the SMTP server
 * rejected the credentials (EAUTH), so nothing will be delivered until the
 * App Password is updated in Settings → מייל.
 *
 * - Inserts the notification row directly (lib/db/notifications), NOT via the
 *   registry fan-out: the fan-out's email channel is the very thing that just
 *   failed, so this path is unable to email by construction — no loop.
 * - Throttled to one alert per SMTP_AUTH_ALERT_THROTTLE_HOURS through the
 *   atomic claim on app_settings 'smtp_last_auth_alert'; the claimed stamp is
 *   part of the dedupe key, so a won slot yields exactly one row per admin.
 * - Never throws: the caller is already dealing with a failed send.
 */
export async function notifyAdminsOfSmtpAuthFailure(): Promise<void> {
  try {
    const slot = await claimSmtpAuthAlertSlot();
    if (!slot) return;
    const admins = await listActiveAdmins();
    for (const admin of admins) {
      try {
        await createNotification({
          userId: admin.id,
          type: 'smtp_auth_failed',
          title: DEFAULT_TITLE.smtp_auth_failed,
          message: SMTP_AUTH_ALERT_MESSAGE,
          sourceModule: 'system',
          sourceEntityType: 'smtp_settings',
          sourceEntityId: 'smtp',
          actionUrl: '/settings',
          priority: 'urgent',
          dedupeKey: `smtp_auth_failed:${admin.id}:${slot.at}`,
        });
      } catch (err) {
        console.error('[smtp auth alert] notification insert failed for', admin.id, err);
      }
    }
  } catch (err) {
    console.error('[smtp auth alert] failed', err);
  }
}

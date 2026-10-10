import 'server-only';
import { createNotification } from '@/lib/db/notifications';
import { listActiveAdmins } from '@/lib/db/users';
import { claimSmtpAuthAlertSlot } from '@/lib/db/appSettings';
import { logger } from '@/lib/logger';
import { raiseSmtpAuthAlert, SMTP_AUTH_ALERT_MESSAGE } from './smtp-auth-alert';

export { SMTP_AUTH_ALERT_MESSAGE };

/**
 * Bell-only alert to every active super_admin / admin: the SMTP server
 * rejected the credentials (EAUTH), so nothing will be delivered until the
 * App Password is updated in Settings → מייל.
 *
 * The mechanism (throttle claim on 'smtp_last_auth_alert', one dedupe-keyed
 * bell row per admin, never throws) lives in smtp-auth-alert.ts and is shared
 * with the delivery worker's email channel; this binds it to the app's DB
 * helpers.
 */
export async function notifyAdminsOfSmtpAuthFailure(): Promise<void> {
  await raiseSmtpAuthAlert({
    claimSlot: claimSmtpAuthAlertSlot,
    listAdmins: listActiveAdmins,
    insertNotification: (input) => createNotification(input),
    logError: (message, ...args) => logger.error(message, ...args),
  });
}

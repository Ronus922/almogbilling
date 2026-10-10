import type { CreateNotificationInput } from '@/lib/types/tasks';
import { DEFAULT_TITLE } from '@/lib/notifications/registry';
import { insertNotificationRow, selectActiveAdmins } from '@/lib/notifications/core';
import type { SqlRunner } from './smtp-core';

// The "SMTP authentication rejected" admin alert — one mechanism for every
// sender: the app's sendWithRetry (src/lib/email/authAlert.ts wires it to the
// app's DB helpers) and the delivery worker's email channel (sqlSmtpAuthAlertDeps
// below, over the worker's own pool). No 'server-only' here, for the worker.

export const SMTP_AUTH_ALERT_MESSAGE =
  'שליחת מייל נכשלה — אימות SMTP נדחה. יש לעדכן App Password בהגדרות מייל';

/** app_settings key holding { at } — when the last alert went out. */
const SMTP_LAST_AUTH_ALERT_KEY = 'smtp_last_auth_alert';

/** Minimum gap between two "SMTP authentication rejected" admin alerts. */
const SMTP_AUTH_ALERT_THROTTLE_HOURS = 6;

/**
 * Claim the right to raise the alert. The row's value is { at: <timestamptz> };
 * the upsert rewrites it only when that stamp is older than the throttle window
 * (or the row does not exist yet), and RETURNING says whether it did: one
 * statement, so two sends failing at the same moment cannot both win.
 * Returns the claimed stamp, or null when throttled. updated_by stays NULL —
 * no user did this, the system did.
 */
export async function claimSmtpAuthAlertSlotWith(db: SqlRunner): Promise<{ at: string } | null> {
  const r = await db.query<{ at: string }>(
    `insert into public.app_settings (key, value, updated_by, updated_at)
     values ($1, jsonb_build_object('at', now()), null, now())
     on conflict (key) do update
       set value = excluded.value,
           updated_at = now()
       where coalesce((public.app_settings.value->>'at')::timestamptz, 'epoch'::timestamptz)
             <= now() - make_interval(hours => $2::int)
     returning (value->>'at') as at`,
    [SMTP_LAST_AUTH_ALERT_KEY, SMTP_AUTH_ALERT_THROTTLE_HOURS],
  );
  return r.rows[0] ? { at: r.rows[0].at } : null;
}

export interface SmtpAuthAlertDeps {
  claimSlot(): Promise<{ at: string } | null>;
  listAdmins(): Promise<{ id: string }[]>;
  insertNotification(input: CreateNotificationInput): Promise<unknown>;
  logError(message: string, ...args: unknown[]): void;
}

/**
 * Bell-only alert to every active super_admin / admin: the SMTP server
 * rejected the credentials (EAUTH), so nothing will be delivered until the
 * App Password is updated in Settings → מייל.
 *
 * - Inserts the notification row directly, NOT via the registry fan-out: the
 *   fan-out's email channel is the very thing that just failed, so this path
 *   is unable to email by construction — no loop.
 * - Throttled to one alert per SMTP_AUTH_ALERT_THROTTLE_HOURS through the
 *   atomic claim on 'smtp_last_auth_alert'; the claimed stamp is part of the
 *   dedupe key, so a won slot yields exactly one row per admin.
 * - Never throws: the caller is already dealing with a failed send.
 */
export async function raiseSmtpAuthAlert(deps: SmtpAuthAlertDeps): Promise<void> {
  try {
    const slot = await deps.claimSlot();
    if (!slot) return;
    const admins = await deps.listAdmins();
    for (const admin of admins) {
      try {
        await deps.insertNotification({
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
        deps.logError('[smtp auth alert] notification insert failed for', admin.id, err);
      }
    }
  } catch (err) {
    deps.logError('[smtp auth alert] failed', err);
  }
}

/** The same three steps over a plain pg pool — for a process outside Next
 *  (the delivery worker), which cannot load the app's server-only DB helpers. */
export function sqlSmtpAuthAlertDeps(
  db: SqlRunner,
  logError: SmtpAuthAlertDeps['logError'],
): SmtpAuthAlertDeps {
  return {
    claimSlot: () => claimSmtpAuthAlertSlotWith(db),
    listAdmins: () => selectActiveAdmins(db),
    insertNotification: (input) => insertNotificationRow(db, input),
    logError,
  };
}

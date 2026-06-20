import 'server-only';
import { withTransaction } from '@/lib/db';
import { listDueReminders, markReminderSent } from '@/lib/db/reminders';
import { createNotification } from '@/lib/db/notifications';
import { getTaskById, listTasksDueSoon } from '@/lib/db/tasks';
import { getIssueById } from '@/lib/db/issues';
import { getEventById } from '@/lib/db/calendarEvents';
import { findUserById, listActiveAdmins } from '@/lib/db/users';
import { listEntityUserIds } from '@/lib/db/entityAssignees';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { sendWhatsAppMessage, normalizePhone } from '@/lib/whatsapp';
import { sendTaskNotificationEmail } from '@/services/email';
import { priorityLabel, createNotification as emitNotification } from '@/services/notifications';
import { appUrl } from '@/lib/config';
import { todayInJerusalem, addDaysToIsoDate } from '@/lib/dates';

export interface ReminderRunResult {
  due: number;
  processed: number;
  notified: number;
  emailed: number;
  /** WhatsApp reminder messages sent this run (channel='whatsapp', per recipient). */
  whatsapped: number;
  failed: number;
  /** task_due_soon notifications fanned out this run (deduped per task/user/day). */
  dueSoon: number;
}

/**
 * Scan for not-completed tasks whose due_date is today or tomorrow (Asia/Jerusalem)
 * — the 24h-forward horizon at date granularity — and fan out a `task_due_soon`
 * notification to the assignee (or, when unassigned, to every active admin).
 *
 * Idempotent: the per-task/per-user/per-day dedupeKey means re-running the cron
 * (every 5 min) never duplicates — at most one alert per task per recipient per
 * day. Uses the registry-driven createNotification (high priority → email +
 * gated WhatsApp). Best-effort; never throws to the caller. Returns the number
 * of notifications enqueued (deduped ones still count as enqueued attempts).
 */
async function scanTasksDueSoon(): Promise<number> {
  const today = todayInJerusalem();
  const tomorrow = addDaysToIsoDate(today, 1);
  const tasks = await listTasksDueSoon(today, tomorrow);
  if (tasks.length === 0) return 0;

  let count = 0;
  for (const task of tasks) {
    const dueLabel = task.due_time ? `${task.due_date} ${task.due_time.slice(0, 5)}` : task.due_date;
    const message = `המשימה "${task.title}" מתקרבת למועד היעד (${dueLabel})`;
    const recipients = task.assigned_user_ids.length > 0
      ? task.assigned_user_ids
      : (await listActiveAdmins()).map((a) => a.id);

    for (const userId of recipients) {
      await emitNotification({
        userId,
        type: 'task_due_soon',
        title: 'משימה מתקרבת למועד',
        message,
        sourceModule: 'tasks',
        sourceEntityType: 'Task',
        sourceEntityId: task.id,
        actionUrl: `/tasks?task=${task.id}`,
        priority: 'high',
        dedupeKey: `task_due_soon:${task.id}:${userId}:${today}`,
      });
      count++;
    }
  }
  return count;
}

/**
 * Process all due, un-sent reminders. For each:
 *  - in_app / both → create an in-app notification
 *  - email / both  → send an email (best-effort)
 *  - mark sent_at (in a transaction with the notification insert)
 *
 * Currently only entity_type='task' is wired for rich content; unknown entity
 * types still get a generic notification + are marked sent so they don't loop.
 */
export async function runReminders(limit = 200): Promise<ReminderRunResult> {
  const due = await listDueReminders(limit);
  const result: ReminderRunResult = {
    due: due.length,
    processed: 0,
    notified: 0,
    emailed: 0,
    whatsapped: 0,
    failed: 0,
    dueSoon: 0,
  };

  for (const reminder of due) {
    try {
      let title = 'תזכורת';
      let message: string | null = 'הגיע מועד התזכורת';
      let actionUrl: string | null = null;
      let emailDetails: { label: string; value: string }[] = [];
      let priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';

      if (reminder.entity_type === 'task') {
        const task = await getTaskById(reminder.entity_id);
        if (task) {
          title = task.title;
          message = 'תזכורת למשימה';
          actionUrl = `/tasks?task=${task.id}`;
          priority = task.priority === 'urgent' ? 'urgent' : 'normal';
          emailDetails = [{ label: 'עדיפות', value: priorityLabel(task.priority) }];
          if (task.due_date) emailDetails.push({ label: 'תאריך יעד', value: task.due_date });
        }
      } else if (reminder.entity_type === 'issue') {
        const issue = await getIssueById(reminder.entity_id);
        if (issue) {
          title = issue.title;
          message = 'תזכורת לתקלה';
          actionUrl = `/issues?issue=${issue.id}`;
          priority = issue.priority === 'urgent' ? 'urgent' : 'normal';
          emailDetails = [{ label: 'עדיפות', value: priorityLabel(issue.priority) }];
        }
      } else if (reminder.entity_type === 'calendar_event') {
        const event = await getEventById(reminder.entity_id);
        if (event) {
          title = event.title;
          message = 'תזכורת לאירוע ביומן';
          actionUrl = '/calendar';
          const details: { label: string; value: string }[] = [
            { label: 'תאריך', value: event.event_date },
          ];
          if (event.location) details.push({ label: 'מיקום', value: event.location });
          if (event.start_datetime && !event.is_all_day) {
            const t = new Date(event.start_datetime);
            if (!Number.isNaN(t.getTime())) {
              details.push({
                label: 'שעה',
                value: t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
              });
            }
          }
          emailDetails = details;
        }
      }

      const wantInApp = reminder.channel === 'in_app' || reminder.channel === 'both';
      const wantEmail = reminder.channel === 'email' || reminder.channel === 'both';
      const wantWhatsApp = reminder.channel === 'whatsapp';

      // Resolve recipients at FIRE TIME: the entity's CURRENT user-assignees,
      // falling back to the reminder's stored user_id (creator/owner) when there
      // are none — and always for entity types with no assignees junction
      // (calendar_event). One reminder row → fans out to every assignee here, so
      // the create/edit routes never duplicate a row per assignee.
      let recipientIds: string[] = [];
      if (reminder.entity_type === 'task' || reminder.entity_type === 'issue') {
        recipientIds = await listEntityUserIds(reminder.entity_type, reminder.entity_id);
      }
      if (recipientIds.length === 0) recipientIds = [reminder.user_id];
      recipientIds = Array.from(new Set(recipientIds));

      const heading =
        reminder.entity_type === 'task'
          ? 'תזכורת למשימה'
          : reminder.entity_type === 'calendar_event'
            ? 'תזכורת לאירוע ביומן'
            : reminder.entity_type === 'issue'
              ? 'תזכורת לתקלה'
              : 'תזכורת';

      // In-app inserts (one per recipient) + mark-sent in one transaction
      // (idempotent re-runs — the dedupeKey is per recipient).
      await withTransaction(async (client) => {
        if (wantInApp) {
          for (const uid of recipientIds) {
            await createNotification(
              {
                userId: uid,
                // Calendar reminders carry the first-class 'calendar_reminder' type
                // (registry icon/tone). Task/issue reminders keep the legacy
                // 'reminder' type unchanged.
                type: reminder.entity_type === 'calendar_event' ? 'calendar_reminder' : 'reminder',
                title,
                message,
                sourceModule:
                  reminder.entity_type === 'task'
                    ? 'tasks'
                    : reminder.entity_type === 'calendar_event'
                      ? 'calendar'
                      : reminder.entity_type,
                sourceEntityType: reminder.entity_type,
                sourceEntityId: reminder.entity_id,
                actionUrl,
                priority,
                dedupeKey: `reminder:${reminder.id}:${uid}`,
              },
              client,
            );
          }
        }
        await markReminderSent(reminder.id, client);
      });
      if (wantInApp) result.notified += recipientIds.length;

      // Email — best-effort, per recipient, outside the transaction (network I/O).
      if (wantEmail) {
        for (const uid of recipientIds) {
          try {
            const user = await findUserById(uid);
            if (user?.email && user.is_active) {
              await sendTaskNotificationEmail(user.email, {
                recipientName: user.full_name ?? user.username,
                heading,
                taskTitle: title,
                details: emailDetails,
                taskUrl: actionUrl ? `${appUrl()}${actionUrl}` : appUrl(),
              });
              result.emailed++;
            }
          } catch (err) {
            console.error('[runReminders] email failed for reminder', reminder.id, err);
          }
        }
      }

      // WhatsApp — best-effort, per recipient. channel='whatsapp' is an EXPLICIT
      // per-reminder choice, so it sends whenever the recipient has a
      // notification phone (NOT gated on the passive notify_whatsapp opt-in, which
      // only governs the automatic notification stream). Fires only here
      // (scheduled), never at create time.
      if (wantWhatsApp) {
        const creds = await getDefaultSendCreds();
        for (const uid of recipientIds) {
          try {
            const user = await findUserById(uid);
            if (creds && user?.is_active && user.notification_phone) {
              const { chatId } = normalizePhone(user.notification_phone);
              await sendWhatsAppMessage({
                instanceId: creds.greenInstanceId,
                token: creds.token,
                apiUrl: creds.apiUrl,
                chatId,
                message: `${heading}\n${title}`,
              });
              result.whatsapped++;
            }
          } catch (err) {
            console.error('[runReminders] whatsapp failed for reminder', reminder.id, err);
          }
        }
      }

      result.processed++;
    } catch (err) {
      result.failed++;
      console.error('[runReminders] failed for reminder', reminder.id, err);
    }
  }

  // Scheduled task_due_soon scan — independent of the explicit-reminders loop, so
  // a failure here never aborts reminder delivery (and vice-versa).
  try {
    result.dueSoon = await scanTasksDueSoon();
  } catch (err) {
    console.error('[runReminders] task_due_soon scan failed', err);
  }

  return result;
}

import 'server-only';
import { withTransaction } from '@/lib/db';
import { listDueReminders, markReminderSent } from '@/lib/db/reminders';
import { createNotification } from '@/lib/db/notifications';
import { getTaskById } from '@/lib/db/tasks';
import { getIssueById } from '@/lib/db/issues';
import { getEventById } from '@/lib/db/calendarEvents';
import { findUserById } from '@/lib/db/users';
import { sendTaskNotificationEmail } from '@/services/email';
import { priorityLabel } from '@/services/notifications';
import { appUrl } from '@/lib/config';

export interface ReminderRunResult {
  due: number;
  processed: number;
  notified: number;
  emailed: number;
  failed: number;
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
    failed: 0,
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

      // Notification insert + mark-sent in one transaction (idempotent re-runs).
      await withTransaction(async (client) => {
        if (wantInApp) {
          await createNotification(
            {
              userId: reminder.user_id,
              type: 'reminder',
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
              dedupeKey: `reminder:${reminder.id}`,
            },
            client,
          );
        }
        await markReminderSent(reminder.id, client);
      });
      if (wantInApp) result.notified++;

      // Email is best-effort and outside the transaction (network I/O).
      if (wantEmail) {
        try {
          const user = await findUserById(reminder.user_id);
          if (user?.email && user.is_active) {
            await sendTaskNotificationEmail(user.email, {
              recipientName: user.full_name ?? user.username,
              heading:
                reminder.entity_type === 'task'
                  ? 'תזכורת למשימה'
                  : reminder.entity_type === 'calendar_event'
                    ? 'תזכורת לאירוע ביומן'
                    : reminder.entity_type === 'issue'
                      ? 'תזכורת לתקלה'
                      : 'תזכורת',
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

      result.processed++;
    } catch (err) {
      result.failed++;
      console.error('[runReminders] failed for reminder', reminder.id, err);
    }
  }

  return result;
}

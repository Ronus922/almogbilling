import 'server-only';
import { appUrl } from '@/lib/config';
import { createNotification } from '@/lib/db/notifications';
import { findUserById } from '@/lib/db/users';
import { sendTaskNotificationEmail } from '@/services/email';
import type { CreateNotificationInput, ReminderChannel, TaskPriority } from '@/lib/types/tasks';

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'נמוכה',
  normal: 'רגילה',
  high: 'גבוהה',
  urgent: 'דחוף',
};

export function priorityLabel(p: TaskPriority): string {
  return PRIORITY_LABELS[p] ?? p;
}

/**
 * Notify a user about a task: create an in-app notification (deduped) and,
 * when requested + the user has an email, send an email. Email failures are
 * swallowed (logged) — never block the originating mutation.
 *
 * `channel` controls email: 'in_app' → no email; 'email'/'both' → email.
 */
export async function notifyTask(opts: {
  userId: string;
  type: string;
  heading: string;
  task: { id: string; title: string; priority?: TaskPriority; due_date?: string | null };
  notificationPriority?: CreateNotificationInput['priority'];
  dedupeKey?: string | null;
  channel?: ReminderChannel;
  extraDetails?: { label: string; value: string }[];
}): Promise<{ notified: boolean; emailed: boolean }> {
  const taskUrl = `${appUrl()}/tasks?task=${opts.task.id}`;
  const message = opts.heading;

  const notification = await createNotification({
    userId: opts.userId,
    type: opts.type,
    title: opts.task.title,
    message,
    sourceModule: 'tasks',
    sourceEntityType: 'task',
    sourceEntityId: opts.task.id,
    actionUrl: `/tasks?task=${opts.task.id}`,
    priority: opts.notificationPriority ?? 'normal',
    dedupeKey: opts.dedupeKey ?? null,
  });

  const wantEmail = opts.channel === undefined || opts.channel === 'email' || opts.channel === 'both';
  let emailed = false;

  if (wantEmail) {
    try {
      const user = await findUserById(opts.userId);
      if (user?.email && user.is_active) {
        const details: { label: string; value: string }[] = [];
        if (opts.task.priority) details.push({ label: 'עדיפות', value: priorityLabel(opts.task.priority) });
        if (opts.task.due_date) details.push({ label: 'תאריך יעד', value: opts.task.due_date });
        if (opts.extraDetails) details.push(...opts.extraDetails);

        await sendTaskNotificationEmail(user.email, {
          recipientName: user.full_name ?? user.username,
          heading: opts.heading,
          taskTitle: opts.task.title,
          details,
          taskUrl,
        });
        emailed = true;
      }
    } catch (err) {
      console.error('[notifyTask] email failed', err);
    }
  }

  return { notified: notification !== null, emailed };
}

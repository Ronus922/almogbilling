import 'server-only';
import { appUrl } from '@/lib/config';
import { createNotification as insertNotification } from '@/lib/db/notifications';
import { findUserById, getNotificationRecipient } from '@/lib/db/users';
import { getDefaultSendCreds } from '@/lib/db/whatsappInstances';
import { sendTaskNotificationEmail, sendNotificationEmail } from '@/services/email';
import { sendWhatsAppMessage, normalizePhone } from '@/lib/whatsapp';
import {
  NOTIFICATION_REGISTRY, PRIORITY_ORDER, DEFAULT_TITLE, PRIORITY_LABEL,
  type CreateNotificationServiceInput,
} from '@/lib/notifications/registry';
import type { CreateNotificationInput, ReminderChannel, TaskPriority } from '@/lib/types/tasks';

const PRIORITY_LABELS: Record<TaskPriority, string> = {
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
 * `channel` controls email: 'in_app' → no email; 'email'/undefined → email.
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

  const notification = await insertNotification({
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

  const wantEmail = opts.channel === undefined || opts.channel === 'email';
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

/**
 * Notify a user about an issue: create an in-app notification (deduped) and,
 * when requested + the user has an email, send an email. Reuses the same email
 * template + best-effort semantics as notifyTask — email failures are swallowed
 * and never block the originating mutation.
 */
export async function notifyIssue(opts: {
  userId: string;
  type: string;
  heading: string;
  issue: { id: string; title: string; priority?: TaskPriority };
  notificationPriority?: CreateNotificationInput['priority'];
  dedupeKey?: string | null;
  channel?: ReminderChannel;
  extraDetails?: { label: string; value: string }[];
}): Promise<{ notified: boolean; emailed: boolean }> {
  const issueUrl = `${appUrl()}/issues?issue=${opts.issue.id}`;

  const notification = await insertNotification({
    userId: opts.userId,
    type: opts.type,
    title: opts.issue.title,
    message: opts.heading,
    sourceModule: 'issues',
    sourceEntityType: 'issue',
    sourceEntityId: opts.issue.id,
    actionUrl: `/issues?issue=${opts.issue.id}`,
    priority: opts.notificationPriority ?? 'normal',
    dedupeKey: opts.dedupeKey ?? null,
  });

  const wantEmail = opts.channel === undefined || opts.channel === 'email';
  let emailed = false;

  if (wantEmail) {
    try {
      const user = await findUserById(opts.userId);
      if (user?.email && user.is_active) {
        const details: { label: string; value: string }[] = [];
        if (opts.issue.priority) details.push({ label: 'עדיפות', value: priorityLabel(opts.issue.priority) });
        if (opts.extraDetails) details.push(...opts.extraDetails);

        await sendTaskNotificationEmail(user.email, {
          recipientName: user.full_name ?? user.username,
          heading: opts.heading,
          taskTitle: opts.issue.title,
          details,
          taskUrl: issueUrl,
        });
        emailed = true;
      }
    } catch (err) {
      console.error('[notifyIssue] email failed', err);
    }
  }

  return { notified: notification !== null, emailed };
}

/**
 * Registry-driven notification entry point — the SINGLE call point for the typed
 * notification stream (whatsapp_message_received, legal_status_changed, …). It:
 *   1. derives priority / channels / sourceModule from NOTIFICATION_REGISTRY,
 *   2. inserts the in-app row with ON CONFLICT(dedupe_key) DO NOTHING,
 *   3. fans out ONLY when a row was actually created (a deduped call is silent),
 *   4. emails (if the type+recipient opt-in allow) and WhatsApps (strictly gated
 *      on priority ≥ high + a phone + an explicit opt-in).
 *
 * NEVER throws to the caller: a failed notification must never break the
 * business action that triggered it. Everything is wrapped + logged.
 *
 * (task_assigned / issue_assigned etc. emitted via notifyTask/notifyIssue keep
 * their richer dedicated email template — this is the path for every other
 * typed notification and shares the same insert + transport primitives.)
 */
export async function createNotification(input: CreateNotificationServiceInput): Promise<void> {
  try {
    const reg = NOTIFICATION_REGISTRY[input.type];
    if (!reg) {
      console.error('[createNotification] unknown notification type', input.type);
      return;
    }

    const priority = input.priority ?? reg.defaultPriority;
    const channels = reg.channels;
    const sourceModule = input.sourceModule ?? reg.sourceModule;
    const title = input.title ?? DEFAULT_TITLE[input.type];
    const dedupeKey =
      input.dedupeKey ?? `${input.type}:${input.sourceEntityId ?? ''}:${input.userId}`;

    const created = await insertNotification({
      userId: input.userId,
      type: input.type,
      title,
      message: input.message,
      sourceModule,
      sourceEntityType: input.sourceEntityType ?? null,
      sourceEntityId: input.sourceEntityId ?? null,
      actionUrl: input.actionUrl ?? null,
      priority,
      dedupeKey,
    });
    // Deduped (DO NOTHING) → the user already has this notification; no fan-out.
    if (!created) return;

    const recipient = await getNotificationRecipient(input.userId);
    if (!recipient || !recipient.is_active) return;

    // ── EMAIL channel ──────────────────────────────────────────────────────
    if (channels.includes('email')) {
      // recipient's own address only if they opted in; extraEmails (e.g. a legal
      // status's notification_emails) are explicit and always sent — one loop, no
      // split logic.
      const toList = Array.from(
        new Set([
          ...(recipient.notify_email && recipient.email ? [recipient.email] : []),
          ...(input.extraEmails ?? []),
        ]),
      );
      for (const to of toList) {
        try {
          await sendNotificationEmail(to, {
            recipientName: recipient.full_name ?? recipient.username,
            title,
            message: input.message,
            actionUrl: input.actionUrl ? `${appUrl()}${input.actionUrl}` : null,
            priorityLabel: PRIORITY_LABEL[priority],
          });
        } catch (err) {
          console.error('[createNotification] email failed for', to, err);
        }
      }
    }

    // ── WHATSAPP channel — strictly gated ──────────────────────────────────
    // Fires ONLY when: the type allows it, priority ≥ high, the recipient has a
    // notification phone AND has explicitly opted in. Defaults (no phone / opt-in
    // off) guarantee nobody gets a WhatsApp until manually enabled.
    if (
      channels.includes('whatsapp') &&
      PRIORITY_ORDER[priority] >= PRIORITY_ORDER.high &&
      recipient.notification_phone &&
      recipient.notify_whatsapp === true
    ) {
      try {
        const creds = await getDefaultSendCreds();
        if (creds) {
          const { chatId } = normalizePhone(recipient.notification_phone);
          const body = title && title !== input.message ? `${title}\n${input.message}` : input.message;
          await sendWhatsAppMessage({
            instanceId: creds.greenInstanceId,
            token: creds.token,
            apiUrl: creds.apiUrl,
            chatId,
            message: body,
          });
        }
      } catch (err) {
        console.error('[createNotification] whatsapp failed', err);
      }
    }
  } catch (err) {
    console.error('[createNotification] failed', err);
  }
}

import 'server-only';
import { sendWithRetry } from '@/lib/email/send';
import { renderTemplate } from '@/lib/email-templates';
import { getSignature, signatureHtml, signaturePlainLines } from '@/lib/notify/signature';

/**
 * Real Gmail-SMTP send (Slice 5).
 */
export async function sendResetPasswordEmail(
  to: string,
  args: { userName: string; resetUrl: string },
): Promise<void> {
  const { subject, html, text } = renderTemplate('reset-password', args);
  await sendWithRetry({ to, subject, html, text });
}

/**
 * User invite email (Slice 6).
 */
export async function sendUserInviteEmail(
  to: string,
  args: { inviterName: string; inviteeName: string; roleLabel: string; acceptUrl: string },
): Promise<void> {
  const { subject, html, text } = renderTemplate('user-invite', { ...args, validHours: 24 });
  await sendWithRetry({ to, subject, html, text });
}

/**
 * Task notification email (Module 1) — used for assignment + reminders.
 */
export async function sendTaskNotificationEmail(
  to: string,
  args: {
    recipientName: string;
    heading: string;
    taskTitle: string;
    details: { label: string; value: string }[];
    taskUrl: string;
  },
): Promise<void> {
  const sig = await getSignature();
  const { subject, html, text } = renderTemplate('task-notification', {
    ...args,
    signatureHtml: signatureHtml(sig),
    signatureText: signaturePlainLines(sig),
  });
  await sendWithRetry({ to, subject, html, text });
}

/**
 * Generic notification email (Notifications module) — the email channel of the
 * createNotification() fan-out. Used for any notification type whose registry
 * channels include 'email' and that has no richer dedicated template (task /
 * issue keep their `task-notification` template via notifyTask/notifyIssue).
 * Built on the same sendWithRetry transporter — no new transport.
 */
export async function sendNotificationEmail(
  to: string,
  args: {
    recipientName: string;
    title: string;
    message: string;
    /** Label/value rows (description, location, due date, assigned-by…) —
     *  rendered under the message; absent rows are simply not passed. */
    details?: { label: string; value: string }[];
    actionUrl?: string | null;
    priorityLabel?: string | null;
  },
): Promise<void> {
  const sig = await getSignature();
  const safe = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = args.title;
  const details = args.details ?? [];
  const lines = [
    `שלום ${safe(args.recipientName)},`,
    '',
    safe(args.message),
    details.length ? `\n${details.map((d) => `${d.label}: ${d.value}`).join('\n')}` : '',
    args.priorityLabel ? `\nעדיפות: ${safe(args.priorityLabel)}` : '',
  ].filter(Boolean);
  const text = `${lines.join('\n')}${args.actionUrl ? `\n\nצפייה: ${args.actionUrl}` : ''}\n\n${signaturePlainLines(sig)}\n\n— ALMOG CRM`;

  const button = args.actionUrl
    ? `<div style="margin-top:20px"><a href="${args.actionUrl}" style="display:inline-block;background:#3d5afe;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">צפייה במערכת</a></div>`
    : '';
  const priority = args.priorityLabel
    ? `<p style="margin:4px 0 0;color:#8a92a6;font-size:13px">עדיפות: ${safe(args.priorityLabel)}</p>`
    : '';
  const detailsHtml = details.length
    ? `<div style="margin-top:12px;padding:12px 16px;background:#f6f7fb;border-radius:8px">${details
        .map(
          (d) =>
            `<p style="margin:4px 0;color:#1a2233;font-size:14px;line-height:1.6"><span style="color:#8a92a6">${safe(d.label)}:</span> ${safe(d.value)}</p>`,
        )
        .join('')}</div>`
    : '';
  const html = `
    <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#ffffff;color:#1a2233;text-align:right">
      <h2 style="margin:0 0 12px;font-size:18px;color:#1a2233">${safe(args.title)}</h2>
      <p style="margin:0;color:#5b6479;font-size:14px">שלום ${safe(args.recipientName)},</p>
      <p style="margin:8px 0 0;color:#1a2233;font-size:15px;line-height:1.6">${safe(args.message)}</p>
      ${detailsHtml}
      ${priority}
      ${button}
      ${signatureHtml(sig)}
      <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e8eaf2" />
      <p style="margin:0;color:#b4bacb;font-size:12px">ALMOG CRM</p>
    </div>`;

  await sendWithRetry({ to, subject, html, text });
}

export interface StatusChangeEmailArgs {
  apartment_number: string;
  owner_name: string | null;
  old_status_name: string | null;
  new_status_name: string | null;
  changed_by_name: string;
  recipients: string[];
}

/**
 * Legal-status change email. The route builds the recipient list (the new
 * status's notification_emails + the lawyer from Settings when the debtor
 * moved INTO a legal status — see buildLegalStatusRecipients); this renders
 * the template once and sends it to each address through sendWithRetry.
 * A failing address is logged and the loop moves on; nothing is thrown — the
 * status change already happened and an email must never undo or block it.
 */
export async function sendStatusChangeNotification(
  args: StatusChangeEmailArgs,
): Promise<{ sent: number; failed: number }> {
  if (args.recipients.length === 0) return { sent: 0, failed: 0 };

  const sig = await getSignature();
  const changedAt = new Date().toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const { subject, html, text } = renderTemplate('legal-status-change', {
    apartmentNumber: args.apartment_number,
    ownerName: args.owner_name,
    oldStatusName: args.old_status_name,
    newStatusName: args.new_status_name,
    changedByName: args.changed_by_name,
    changedAt,
    signatureHtml: signatureHtml(sig),
    signatureText: signaturePlainLines(sig),
  });

  let sent = 0;
  let failed = 0;
  for (const to of args.recipients) {
    try {
      await sendWithRetry({ to, subject, html, text });
      sent++;
    } catch (err) {
      failed++;
      console.error('[sendStatusChangeNotification] failed for', to, err);
    }
  }
  return { sent, failed };
}

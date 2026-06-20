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
    actionUrl?: string | null;
    priorityLabel?: string | null;
  },
): Promise<void> {
  const sig = await getSignature();
  const safe = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = args.title;
  const lines = [
    `שלום ${safe(args.recipientName)},`,
    '',
    safe(args.message),
    args.priorityLabel ? `\nעדיפות: ${safe(args.priorityLabel)}` : '',
  ].filter(Boolean);
  const text = `${lines.join('\n')}${args.actionUrl ? `\n\nצפייה: ${args.actionUrl}` : ''}\n\n${signaturePlainLines(sig)}\n\n— ALMOG CRM`;

  const button = args.actionUrl
    ? `<div style="margin-top:20px"><a href="${args.actionUrl}" style="display:inline-block;background:#3d5afe;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600">צפייה במערכת</a></div>`
    : '';
  const priority = args.priorityLabel
    ? `<p style="margin:4px 0 0;color:#8a92a6;font-size:13px">עדיפות: ${safe(args.priorityLabel)}</p>`
    : '';
  const html = `
    <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#ffffff;color:#1a2233;text-align:right">
      <h2 style="margin:0 0 12px;font-size:18px;color:#1a2233">${safe(args.title)}</h2>
      <p style="margin:0;color:#5b6479;font-size:14px">שלום ${safe(args.recipientName)},</p>
      <p style="margin:8px 0 0;color:#1a2233;font-size:15px;line-height:1.6">${safe(args.message)}</p>
      ${priority}
      ${button}
      ${signatureHtml(sig)}
      <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e8eaf2" />
      <p style="margin:0;color:#b4bacb;font-size:12px">ALMOG CRM</p>
    </div>`;

  await sendWithRetry({ to, subject, html, text });
}

// ──────────────────────────────────────────────────────────────────────
// LEGACY — Slice 3 stub kept untouched. Will migrate in a separate slice.
// ──────────────────────────────────────────────────────────────────────

interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

async function sendEmailStub(msg: EmailMessage): Promise<{ ok: true; mocked: true }> {
  console.log('\n[email:stub] ────────────────────────');
  console.log(`  To:      ${msg.to}`);
  console.log(`  Subject: ${msg.subject}`);
  console.log(`  Body:`);
  msg.body.split('\n').forEach((l) => console.log('    ' + l));
  console.log('─────────────────────────────────────\n');
  return { ok: true, mocked: true };
}

export interface StatusChangeEmailArgs {
  apartment_number: string;
  owner_name: string | null;
  old_status_name: string | null;
  new_status_name: string | null;
  changed_by_name: string;
  recipients: string[];
}

export async function sendStatusChangeNotification(args: StatusChangeEmailArgs): Promise<void> {
  if (args.recipients.length === 0) return;

  const when = new Date().toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const owner = args.owner_name ?? '—';
  const oldName = args.old_status_name ?? '(ללא סטטוס)';
  const newName = args.new_status_name ?? '(ללא סטטוס)';

  const subject = `עדכון סטטוס משפטי — דירה ${args.apartment_number}`;
  const body =
    `שלום,\n\n` +
    `הדירה ${args.apartment_number} של ${owner} שונתה:\n` +
    `מ: ${oldName}\n` +
    `ל: ${newName}\n\n` +
    `בוצע על ידי: ${args.changed_by_name}\n` +
    `בתאריך: ${when}\n\n` +
    `---\n` +
    `ALMOG CRM — https://billing.bios.co.il`;

  for (const to of args.recipients) {
    try {
      await sendEmailStub({ to, subject, body });
    } catch (err) {
      console.error('[sendStatusChangeNotification] failed for', to, err);
    }
  }
}

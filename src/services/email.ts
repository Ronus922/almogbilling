import 'server-only';
import { sendWithRetry } from '@/lib/email/send';
import { renderTemplate } from '@/lib/email-templates';

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

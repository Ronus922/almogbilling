// Stub email service. TODO: replace with real SMTP (Resend) in phase B.

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(msg: EmailMessage): Promise<{ ok: true; mocked: true }> {
  console.log('\n[email:stub] ────────────────────────');
  console.log(`  To:      ${msg.to}`);
  console.log(`  Subject: ${msg.subject}`);
  console.log(`  Body:`);
  msg.body.split('\n').forEach((l) => console.log('    ' + l));
  console.log('─────────────────────────────────────\n');
  return { ok: true, mocked: true };
}

export async function sendPasswordReset(email: string, resetUrl: string) {
  return sendEmail({
    to: email,
    subject: 'איפוס סיסמה ל-ALMOG CRM',
    body:
      `שלום,\n\n` +
      `לחץ על הקישור הבא כדי לאפס את הסיסמה שלך:\n${resetUrl}\n\n` +
      `הקישור יפוג תוקף תוך 60 דקות.\n\n` +
      `אם לא ביקשת איפוס סיסמה, התעלם מהמייל.`,
  });
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
      await sendEmail({ to, subject, body });
    } catch (err) {
      console.error('[sendStatusChangeNotification] failed for', to, err);
    }
  }
}

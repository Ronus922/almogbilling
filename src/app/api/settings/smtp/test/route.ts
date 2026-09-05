import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth/actor';
import type { Actor } from '@/lib/auth/actor';
import { authErrorResponse } from '@/lib/auth/apiGuard';
import { sendWithRetry } from '@/lib/email/send';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c]!;
  });
}

export async function POST(req: Request) {
  let actor: Actor;
  try {
    actor = await requirePermission('settings', 'edit');
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }

  let body: { to?: unknown };
  try {
    body = (await req.json()) as { to?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!EMAIL_RX.test(to)) {
    return NextResponse.json({ error: 'כתובת אימייל לא תקינה' }, { status: 400 });
  }

  const senderLabel = actor.full_name?.trim() || actor.email;
  const sentAt = new Date().toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const subject = 'בדיקה — ALMOG CRM SMTP';
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body dir="rtl" style="margin:0;padding:0;background:#f1f5f9;font-family:'Heebo',Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="500" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;max-width:500px;">
      <tr><td align="right" style="padding:32px 32px 0 32px;">
        <div style="font-size:24px;font-weight:800;color:#0f172a;">אלמוג</div>
      </td></tr>
      <tr><td style="padding:16px 32px 0 32px;font-size:15px;line-height:1.6;color:#334155;">
        זוהי הודעת בדיקה ממערכת ALMOG CRM. אם קיבלת אותה — הגדרות ה-SMTP עובדות כמו שצריך ✓
      </td></tr>
      <tr><td style="padding:24px 32px 32px 32px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;margin-top:16px;">
        נשלח על ידי ${escapeHtml(senderLabel)} • ${escapeHtml(sentAt)}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = `זוהי הודעת בדיקה ממערכת ALMOG CRM.
אם קיבלת אותה — הגדרות ה-SMTP עובדות כמו שצריך.

נשלח על ידי ${senderLabel} • ${sentAt}
`;

  try {
    await sendWithRetry({ to, subject, html, text });
  } catch (err) {
    logger.error('[settings/smtp/test] send failed', err);
    return NextResponse.json({ error: `שליחה נכשלה: ${(err as Error).message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

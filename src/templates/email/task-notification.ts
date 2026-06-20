interface Args {
  recipientName: string;
  /** Heading line, e.g. "משימה חדשה הוקצתה לך" or "תזכורת". */
  heading: string;
  taskTitle: string;
  /** Optional detail lines (priority, due date, assigner) already humanized. */
  details: { label: string; value: string }[];
  taskUrl: string;
  /** Fixed signature block (pre-rendered HTML) appended before the footer. */
  signatureHtml: string;
  /** Fixed signature (plain text) appended to the text part. */
  signatureText: string;
}

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c]!;
  });
}

export function taskNotificationTemplate(args: Args): Rendered {
  const subject = `${args.heading} — ${args.taskTitle}`;
  const safeName = escapeHtml(args.recipientName);
  const safeHeading = escapeHtml(args.heading);
  const safeTitle = escapeHtml(args.taskTitle);
  const url = args.taskUrl;

  const detailRows = args.details
    .map(
      (d) => `
        <tr>
          <td style="padding:4px 40px 0 40px;font-size:14px;color:#64748b;line-height:1.7;">
            <strong style="color:#334155;">${escapeHtml(d.label)}:</strong> ${escapeHtml(d.value)}
          </td>
        </tr>`,
    )
    .join('');

  const detailsText = args.details.map((d) => `${d.label}: ${d.value}`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;600;700;800&display=swap" rel="stylesheet">
</head>
<body dir="rtl" style="margin:0;padding:0;background:#f1f5f9;font-family:'Heebo',Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;max-width:600px;">
        <tr>
          <td align="right" style="padding:32px 40px 0 40px;">
            <div style="font-size:28px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">אלמוג</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0 40px;font-size:18px;font-weight:600;color:#0f172a;">
            שלום ${safeName},
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;font-size:15px;line-height:1.6;color:#334155;">
            ${safeHeading}: <strong style="color:#0f172a;">${safeTitle}</strong>
          </td>
        </tr>
        ${detailRows}
        <tr>
          <td align="right" style="padding:24px 40px 0 40px;">
            <a href="${url}" style="display:inline-block;background:#2563eb;color:#ffffff;font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px;text-decoration:none;font-family:'Heebo',Arial,sans-serif;">
              פתח את המשימה
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0 40px;font-size:12px;color:#94a3b8;line-height:1.5;">
            אם הכפתור לא עובד, העתק את הקישור הבא לדפדפן:
          </td>
        </tr>
        <tr>
          <td dir="ltr" align="left" style="padding:4px 40px 0 40px;font-size:12px;color:#2563eb;word-break:break-all;font-family:'Heebo',Arial,sans-serif;">
            ${url}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0 40px;">
            ${args.signatureHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px 40px;">
            <div style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:12px;color:#64748b;text-align:center;">
              ALMOG CRM &bull; <a href="https://billing.bios.co.il" style="color:#64748b;text-decoration:none;">billing.bios.co.il</a>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = `שלום ${args.recipientName},

${args.heading}: ${args.taskTitle}
${detailsText}

פתח את המשימה:
${args.taskUrl}

${args.signatureText}

—
ALMOG CRM
https://billing.bios.co.il
`;

  return { subject, html, text };
}

import { emailFooterHtmlFor, emailFooterTextFor } from './footer-core';

// One email of a broadcast ("תפוצה" on the email channel). The operator writes
// plain text — the same body a WhatsApp broadcast carries, placeholders already
// resolved per recipient — so the HTML part is that text, escaped, line by
// line, inside the standard email frame (DESIGN.md §24). No greeting and no
// deep link: the message is the operator's, start to end.
//
// Pure on purpose (no '@/lib/config'): the delivery worker renders it outside
// Next, and passes the public origin in.

interface Args {
  /** Subject after placeholder interpolation. */
  subject: string;
  /** Body after placeholder interpolation (plain text, newlines kept). */
  body: string;
  /** Public origin without a trailing slash, e.g. "https://almog-haifa.co.il". */
  site: string;
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

export function broadcastEmailTemplate(args: Args): Rendered {
  const bodyHtml = escapeHtml(args.body.trim()).replace(/\r?\n/g, '<br>');

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(args.subject)}</title>
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
          <td align="right" dir="rtl" style="padding:24px 40px 0 40px;font-size:15px;line-height:1.7;color:#334155;text-align:right;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 32px 40px;">
            ${emailFooterHtmlFor(args.site)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = `${args.body.trim()}

—
${emailFooterTextFor(args.site)}
`;

  return { subject: args.subject, html, text };
}

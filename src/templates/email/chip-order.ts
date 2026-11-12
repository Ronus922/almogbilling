import { emailFooterHtml, emailFooterText } from '@/templates/email/footer';
import { escapeHtml } from '@/templates/email/legal-status-change';
import type { ChipOrderMessage } from '@/lib/chipOrders/messages';

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

/** One paragraph: escaped text; a URL becomes a link ONLY when it is one of
 *  the message's own links (the tracking page, Grow's invoice) — never text
 *  the resident typed. */
function paragraphHtml(line: string, links: readonly string[]): string {
  return line
    .split(URL_RE)
    .map((part, i) =>
      i % 2 === 1 && links.includes(part)
        ? `<a href="${escapeHtml(part)}" style="color:#2563eb;font-family:'Heebo',Arial,sans-serif;word-break:break-all;">${escapeHtml(part)}</a>`
        : escapeHtml(part),
    )
    .join('');
}

/**
 * A chip-order status email (received & paid / approved / ready / rejected).
 * The wording is chipOrderMessage()'s, shared with the WhatsApp channel; this
 * only puts it in the standard frame. The invoice itself is Grow's — linked,
 * never attached or copied.
 */
export function chipOrderEmailTemplate(msg: ChipOrderMessage): Rendered {
  const rows = msg.lines
    .map(
      (l, i) => `
        <tr>
          <td style="padding:${i === 0 ? '24px' : '12px'} 40px 0 40px;font-size:${i === 0 ? '18px' : '15px'};${i === 0 ? 'font-weight:600;color:#0f172a;' : 'color:#334155;'}line-height:1.7;">
            ${paragraphHtml(l, msg.links)}
          </td>
        </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(msg.subject)}</title>
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
        ${rows}
        <tr>
          <td style="padding:24px 40px 32px 40px;">
            ${emailFooterHtml()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = `${msg.lines.join('\n\n')}\n\n— ${emailFooterText()}`;
  return { subject: msg.subject, html, text };
}

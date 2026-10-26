import { emailFooterHtml, emailFooterText } from '@/templates/email/footer';
import { escapeHtml } from '@/templates/email/legal-status-change';

interface Change {
  apartmentNumber: string;
  ownerName: string | null;
  oldStatusName: string | null;
}

interface Args {
  newStatusName: string;
  /** One entry per apartment whose status changed, already in display order. */
  changes: Change[];
  changedByName: string;
  /** Already formatted for display (he-IL, Asia/Jerusalem). */
  changedAt: string;
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

const NO_STATUS = '(ללא סטטוס)';

function apartmentsLabel(n: number): string {
  return n === 1 ? 'דירה אחת' : `${n} דירות`;
}

/**
 * ONE notice for a bulk legal-status change — the apartments and, for each,
 * old ← new — instead of one mail per apartment. Same recipients rule and same
 * frame as the single-apartment notice (legal-status-change.ts): external
 * addresses, so no personal greeting and no deep link into the app.
 */
export function legalStatusBulkChangeTemplate(args: Args): Rendered {
  const count = apartmentsLabel(args.changes.length);
  const subject = `עדכון סטטוס משפטי — ${count}`;
  const newName = args.newStatusName;

  const cell = 'padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#334155;text-align:right;';
  const head = 'padding:8px 12px;border-bottom:1px solid #cbd5e1;font-size:13px;font-weight:700;color:#64748b;text-align:right;';
  const tableRows = args.changes
    .map(
      (c) => `
              <tr>
                <td style="${cell}font-weight:700;color:#0f172a;">${escapeHtml(c.apartmentNumber)}</td>
                <td style="${cell}">${c.ownerName ? escapeHtml(c.ownerName) : '—'}</td>
                <td style="${cell}">${escapeHtml(c.oldStatusName ?? NO_STATUS)} &larr; ${escapeHtml(newName)}</td>
              </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
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
            שלום,
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;font-size:15px;line-height:1.6;color:#334155;">
            הסטטוס המשפטי של <strong style="color:#0f172a;">${escapeHtml(count)}</strong> עודכן ל-<strong style="color:#0f172a;">${escapeHtml(newName)}</strong>:
          </td>
        </tr>
        <tr>
          <td style="padding:12px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;">
              <tr>
                <td style="${head}">דירה</td>
                <td style="${head}">בעלים</td>
                <td style="${head}">סטטוס קודם ← חדש</td>
              </tr>${tableRows}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 40px 0 40px;font-size:14px;color:#64748b;line-height:1.7;">
            <strong style="color:#334155;">תאריך:</strong> ${escapeHtml(args.changedAt)}<br>
            <strong style="color:#334155;">עודכן על ידי:</strong> ${escapeHtml(args.changedByName)}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 0 40px;">
            ${args.signatureHtml}
          </td>
        </tr>
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

  const lines = args.changes.map(
    (c) => `דירה ${c.apartmentNumber}${c.ownerName ? ` · ${c.ownerName}` : ''} · ${c.oldStatusName ?? NO_STATUS} ← ${newName}`,
  );
  const text = `שלום,

הסטטוס המשפטי של ${count} עודכן ל-${newName}:

${lines.join('\n')}

תאריך: ${args.changedAt}
עודכן על ידי: ${args.changedByName}

${args.signatureText}

—
${emailFooterText()}
`;

  return { subject, html, text };
}

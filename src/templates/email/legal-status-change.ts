interface Args {
  apartmentNumber: string;
  ownerName: string | null;
  oldStatusName: string | null;
  newStatusName: string | null;
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c]!;
  });
}

/**
 * Legal-status change notice — sent to the addresses configured on the new
 * status and, when the debtor moved INTO a legal status, to the lawyer from
 * Settings. Recipients may be external (no CRM account), so there is no
 * personal greeting and no deep link into the app.
 */
export function legalStatusChangeTemplate(args: Args): Rendered {
  const subject = `עדכון סטטוס משפטי — דירה ${args.apartmentNumber}`;
  const oldName = args.oldStatusName ?? NO_STATUS;
  const newName = args.newStatusName ?? NO_STATUS;

  const rows: { label: string; value: string }[] = [
    { label: 'דירה', value: args.apartmentNumber },
    ...(args.ownerName ? [{ label: 'בעלים', value: args.ownerName }] : []),
    { label: 'סטטוס קודם', value: oldName },
    { label: 'סטטוס חדש', value: newName },
    { label: 'תאריך', value: args.changedAt },
    { label: 'עודכן על ידי', value: args.changedByName },
  ];

  const detailRows = rows
    .map(
      (d) => `
        <tr>
          <td style="padding:4px 40px 0 40px;font-size:14px;color:#64748b;line-height:1.7;">
            <strong style="color:#334155;">${escapeHtml(d.label)}:</strong> ${escapeHtml(d.value)}
          </td>
        </tr>`,
    )
    .join('');

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
            שלום,
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0 40px;font-size:15px;line-height:1.6;color:#334155;">
            הסטטוס המשפטי של <strong style="color:#0f172a;">דירה ${escapeHtml(args.apartmentNumber)}</strong> עודכן:
          </td>
        </tr>
        <tr>
          <td style="padding:12px 40px 0 40px;font-size:16px;font-weight:700;color:#0f172a;line-height:1.6;">
            ${escapeHtml(oldName)} &larr; ${escapeHtml(newName)}
          </td>
        </tr>
        ${detailRows}
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

  const text = `שלום,

הסטטוס המשפטי של דירה ${args.apartmentNumber} עודכן:
${oldName} ← ${newName}

${rows.map((d) => `${d.label}: ${d.value}`).join('\n')}

${args.signatureText}

—
ALMOG CRM
https://billing.bios.co.il
`;

  return { subject, html, text };
}

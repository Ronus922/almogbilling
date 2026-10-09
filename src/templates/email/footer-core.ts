// The footer markup itself — pure, for a process outside Next that cannot
// load '@/lib/config' (the delivery worker's email channel). footer.ts binds
// it to appUrl() for the app's own templates.

/** The HTML footer for a public origin without a trailing slash — the inner
 *  <div>, so each template keeps its own <td> padding. */
export function emailFooterHtmlFor(site: string): string {
  return `<div style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:12px;color:#64748b;text-align:center;">
              ALMOG CRM &bull; <a href="${site}" style="color:#64748b;text-decoration:none;">${new URL(site).host}</a>
            </div>`;
}

/** The plain-text footer, without the leading em dash separator. */
export function emailFooterTextFor(site: string): string {
  return `ALMOG CRM\n${site}`;
}

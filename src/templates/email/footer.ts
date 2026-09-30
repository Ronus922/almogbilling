import { appUrl } from '@/lib/config';

/**
 * The footer every transactional email ends with. The address is derived from
 * APP_URL (the public origin) rather than hardcoded, so moving the app to a new
 * domain does not leave four templates pointing at the old one.
 */

/** Public origin without a trailing slash, e.g. "https://almog-haifa.co.il". */
function site(): string {
  return appUrl();
}

/** Host only, for display, e.g. "almog-haifa.co.il". */
function siteHost(): string {
  return new URL(site()).host;
}

/** The HTML footer — the inner <div>, so each template keeps its own <td> padding. */
export function emailFooterHtml(): string {
  return `<div style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:12px;color:#64748b;text-align:center;">
              ALMOG CRM &bull; <a href="${site()}" style="color:#64748b;text-decoration:none;">${siteHost()}</a>
            </div>`;
}

/** The plain-text footer, without the leading em dash separator. */
export function emailFooterText(): string {
  return `ALMOG CRM\n${site()}`;
}

import { appUrl } from '@/lib/config';
import { emailFooterHtmlFor, emailFooterTextFor } from './footer-core';

/**
 * The footer every transactional email ends with. The address is derived from
 * APP_URL (the public origin) rather than hardcoded, so moving the app to a new
 * domain does not leave the templates pointing at the old one.
 */

/** The HTML footer — the inner <div>, so each template keeps its own <td> padding. */
export function emailFooterHtml(): string {
  return emailFooterHtmlFor(appUrl());
}

/** The plain-text footer, without the leading em dash separator. */
export function emailFooterText(): string {
  return emailFooterTextFor(appUrl());
}

import { PORTAL_OTP_DIGITS } from '@/lib/constants/portal';

/**
 * Pulls the code out of arbitrary pasted/clipboard/WebOTP text: the first run
 * of EXACTLY `digits` consecutive digits, not touching a digit on either
 * side. Pure and isomorphic — the paste handler, the clipboard-read button
 * and the WebOTP callback in PortalOtpStep all go through this one function,
 * so "what counts as the code" cannot drift between them.
 *
 * A run of consecutive digits only, not every digit in the text: both
 * messages the portal sends now carry other numbers next to the code (the
 * validity line, the WebOTP domain-binding trailer), and naively stripping
 * every non-digit character would concatenate them into garbage. A longer
 * digit run (a phone number, a date written without separators) is rejected
 * on purpose rather than sliced down to its first `digits` characters.
 */
export function extractOtpCode(text: string, digits: number = PORTAL_OTP_DIGITS): string | null {
  const re = new RegExp(`(?<!\\d)\\d{${digits}}(?!\\d)`);
  return text.match(re)?.[0] ?? null;
}

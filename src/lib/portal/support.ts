// The management company's contact details, as the portal shows them.
//
// Both values come from the environment (NEXT_PUBLIC_PORTAL_SUPPORT_PHONE /
// _EMAIL) and are OPTIONAL: with neither set the "פנייה לחברת הניהול" action is
// not drawn at all, because an action that reaches nobody is worse than no
// action. Nothing here validates ownership of the number — it is display and a
// tel:/mailto: target, never an identity.

/** 048341881 → 04-834-1881 · 0501234567 → 050-123-4567. Anything that is not a
 *  plain Israeli number is returned trimmed, exactly as configured. */
export function formatSupportPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/\D+/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  if (digits.length === 10 && digits.startsWith('0')) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // Nine digits = a landline with a two-digit area code (04-834-1881).
  if (digits.length === 9 && digits.startsWith('0')) {
    return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
  }
  return trimmed;
}

/** What the dialler receives. E.164 when the number is clearly Israeli, so the
 *  call connects from abroad too; otherwise the digits as configured. */
export function supportTelHref(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) return `tel:+${trimmed.replace(/\D+/g, '')}`;
  let digits = trimmed.replace(/\D+/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('972')) return `tel:+${digits}`;
  if (digits.startsWith('0')) return `tel:+972${digits.slice(1)}`;
  return `tel:${digits}`;
}

/** Is there anything at all to show? Callers that draw their own layout around
 *  the action ask this first, so a missing configuration leaves no empty box
 *  and no lonely secondary button behind. */
export function hasPortalSupport(support: { phone?: string | null; email?: string | null }): boolean {
  return Boolean((support.phone ?? '').trim() || (support.email ?? '').trim());
}

/** A pre-addressed message to the management company. `subject` is encoded, so
 *  a Hebrew subject with a dash survives the mail client. */
export function supportMailtoHref(
  email: string | null | undefined,
  subject?: string,
): string | null {
  const address = (email ?? '').trim();
  if (!address) return null;
  const s = (subject ?? '').trim();
  return s ? `mailto:${address}?subject=${encodeURIComponent(s)}` : `mailto:${address}`;
}

/** The subject of the join request state 16 offers. The number is part of it
 *  so the management company can look the flat up without a reply. */
export function joinRequestSubject(phoneDisplay: string): string {
  return `בקשת הצטרפות לפורטל — ${phoneDisplay}`;
}

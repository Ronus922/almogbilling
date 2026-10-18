// Shared, pure logic for the single-send recipient picker — the candidate list
// a debtor's apartment offers (owner / tenant / additional owner-tenant) and
// how those candidates are labelled. Used by BOTH the client compose form
// (WhatsAppSendForm) and the server route (/api/whatsapp/send), so the two
// never disagree about which phones are valid for a debtor — the server must
// accept exactly what the client offered, including the "additional" people
// that come from a separate table (contact_people), not the debtor row.
//
// NOT 'server-only': buildPrimaryRecipientCandidates / mergeRecipientCandidates
// are pure helpers with no DB access, imported by a 'use client' component —
// same rule as @/lib/whatsapp's parsePhoneCandidates.

import { parsePhoneCandidates, type PhoneCandidate } from '@/lib/whatsapp';

export type { PhoneCandidate };

/** Sanity cap on POST /api/whatsapp/send's `recipients` array — well above any
 *  real apartment's candidate count (owner + tenant + a couple of additional
 *  people); the real limit is "must be one of the debtor's own candidates",
 *  enforced server-side per phone. */
export const WHATSAPP_SEND_MAX_RECIPIENTS = 10;

/** Build the debtor's own candidates: phone_owner → "בעלים", phone_tenant →
 *  "שוכר/ת". Labels derive from the field, not the string — each field is
 *  parsed ALONE (parsePhoneCandidates' own robust compound/labelled-string
 *  handling, first valid number wins), so `phone` comes out in the candidate's
 *  native international form (the contract every caller — display, the wire
 *  payload, the server's own re-validation — relies on; it must stay
 *  international, never swapped for a local-format cleaner). Falls back to
 *  parsing the combined raw fields only when both are empty/invalid (legacy
 *  compound values still lurking in the column, e.g. the label sitting in
 *  phone_tenant instead of phone_owner). */
export function buildPrimaryRecipientCandidates(r: {
  phone_owner: string | null;
  phone_tenant: string | null;
}): PhoneCandidate[] {
  const owner = parsePhoneCandidates(r.phone_owner)[0]?.phone ?? null;
  const tenant = parsePhoneCandidates(r.phone_tenant)[0]?.phone ?? null;
  const primary: PhoneCandidate[] = [];
  if (owner) primary.push({ phone: owner, label: 'בעלים' });
  if (tenant && tenant !== owner) primary.push({ phone: tenant, label: 'שוכר/ת' });
  if (primary.length > 0) return primary;
  return parsePhoneCandidates(`${r.phone_owner ?? ''} ${r.phone_tenant ?? ''}`);
}

/** Append the apartment-card extras ("מקבל הודעות" additional owners/tenants),
 *  dropping any number already in the primary list. */
export function mergeRecipientCandidates(
  primary: PhoneCandidate[],
  extra: PhoneCandidate[],
): PhoneCandidate[] {
  const seen = new Set(primary.map((c) => c.phone));
  const out = [...primary];
  for (const c of extra) {
    if (seen.has(c.phone)) continue;
    seen.add(c.phone);
    out.push(c);
  }
  return out;
}

/** Label for one extra ("additional") owner/tenant — shared by the client's
 *  fetch of GET /api/whatsapp/recipient-phones and the server's own
 *  re-derivation of the same candidate set for validation. */
export function extraRecipientLabel(role: 'owner' | 'tenant', name: string | null): string {
  const base = role === 'owner' ? 'בעלים נוסף' : 'שוכר נוסף';
  return name ? `${base} · ${name}` : base;
}

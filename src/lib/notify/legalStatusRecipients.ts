import { isLegalStatusName } from '@/lib/constants/statuses';

/**
 * Recipients of the legal-status change email: the addresses configured on the
 * new status, plus the lawyer from Settings (app_settings 'legal_contact')
 * when the debtor moved INTO a legal status. An empty legal email means "not
 * configured" and is skipped silently. Trimmed, lower-cased, de-duplicated;
 * blanks dropped. Pure — the route reads the setting, this only decides.
 */
export function buildLegalStatusRecipients(input: {
  statusEmails: readonly string[] | null | undefined;
  newStatusName: string | null | undefined;
  legalEmail: string | null | undefined;
}): string[] {
  const out = new Set<string>();
  for (const e of input.statusEmails ?? []) {
    const v = e.trim().toLowerCase();
    if (v) out.add(v);
  }
  if (isLegalStatusName(input.newStatusName)) {
    const legal = (input.legalEmail ?? '').trim().toLowerCase();
    if (legal) out.add(legal);
  }
  return [...out];
}

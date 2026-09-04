// Status names that drive KPIs / tabs and the legal-contact notification.
// Seeded by 003_debtor_panel.sql. If a seed name changes, update here in
// lockstep — this module is the single place those names are spelled out.

export const STATUS_WARNING = 'מכתב התראה';
export const STATUS_LEGAL_CARE = 'לטיפול משפטי';
export const STATUS_LEGAL_PROCEEDING = 'בהליך משפטי';

/** The statuses that mean "the lawyer is involved" — a change INTO one of
 *  them is also announced to the legal contact configured in Settings. */
export const LEGAL_STATUS_NAMES: readonly string[] = [STATUS_LEGAL_CARE, STATUS_LEGAL_PROCEEDING];

export function isLegalStatusName(name: string | null | undefined): boolean {
  return !!name && LEGAL_STATUS_NAMES.includes(name.trim());
}

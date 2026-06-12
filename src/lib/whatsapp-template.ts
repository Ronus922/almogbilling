// WhatsApp template interpolation. Client-safe (NO `server-only`): the send
// panel renders a live preview on the client AND the send route interpolates
// on the server — both import from here, single source of truth.

const ilsFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

/** Formats a debt amount with ₪ and a thousands separator, e.g. "₪ 12,500". */
export function formatDebt(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `₪ ${ilsFmt.format(Math.round(n))}`;
}

/** Minimal debtor shape the template placeholders resolve against. */
export interface TemplateDebtor {
  owner_name?: string | null;
  tenant_name?: string | null;
  /** {{debt}} — total debt (`total_debt`). */
  total_debt?: number | null;
  /** {{monthly}} — monthly management-fee debt. In proj_billing this is the
   *  `management_fees` numeric column; `monthly_debt` is a TEXT month-range
   *  ("7/25 - 6/26") from the Bllink sync, NOT a money value. */
  management_fees?: number | null;
  /** {{special}} — special debt (`special_debt`). */
  special_debt?: number | null;
}

/** Supported placeholders — also drives the insert buttons in the composer. */
export const TEMPLATE_PLACEHOLDERS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{name}}',    label: 'שם הדייר' },
  { token: '{{debt}}',    label: 'סה״כ חוב' },
  { token: '{{monthly}}', label: 'דמי ניהול' },
  { token: '{{special}}', label: 'חוב מיוחד' },
] as const;

/** owner_name → tenant_name (first non-empty), trimming separator chars like
 *  "/" or "," (and whitespace) from the edges. Empty → "דייר יקר". */
function resolveName(debtor: TemplateDebtor): string {
  const clean = (v: string | null | undefined): string =>
    (v ?? '').replace(/^[\s\/,]+|[\s\/,]+$/g, '').trim();
  return clean(debtor.owner_name) || clean(debtor.tenant_name) || 'דייר יקר';
}

/**
 * Replaces `{{placeholder}}` tokens with the debtor's values.
 *   {{name}}    → owner_name || tenant_name (cleaned) | "דייר יקר"
 *   {{debt}}    → formatted total_debt (₪ + thousands)
 *   {{monthly}} → formatted management_fees
 *   {{special}} → formatted special_debt
 * Money is formatted with Intl.NumberFormat('he-IL') + ₪; null → ₪ 0.
 * An UNKNOWN placeholder is left verbatim (e.g. "{{foo}}" stays "{{foo}}").
 */
export function interpolateTemplate(content: string, debtor: TemplateDebtor): string {
  const values: Record<string, string> = {
    name: resolveName(debtor),
    debt: formatDebt(debtor.total_debt ?? 0),
    monthly: formatDebt(debtor.management_fees ?? 0),
    special: formatDebt(debtor.special_debt ?? 0),
  };

  return content.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );
}

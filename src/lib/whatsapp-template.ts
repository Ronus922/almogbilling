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
  total_debt?: number | null;
  apartment_number?: string | null;
  /** {{building_name}} source. The schema has no dedicated building column, so
   *  `address` (the building's address) is the closest available value. */
  address?: string | null;
  building_name?: string | null;
}

/** Supported placeholders — also drives the insert buttons in the composer. */
export const TEMPLATE_PLACEHOLDERS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{name}}',          label: 'שם' },
  { token: '{{debt}}',          label: 'חוב' },
  { token: '{{apartment}}',     label: 'דירה' },
  { token: '{{building_name}}', label: 'בניין' },
] as const;

/**
 * Replaces `{{placeholder}}` tokens with the debtor's values.
 *   {{name}}          → owner_name || tenant_name
 *   {{debt}}          → formatted total_debt (₪ + thousands)
 *   {{apartment}}     → apartment_number
 *   {{building_name}} → building_name || address
 * An UNKNOWN placeholder is left verbatim (e.g. "{{foo}}" stays "{{foo}}").
 */
export function interpolateTemplate(content: string, debtor: TemplateDebtor): string {
  const values: Record<string, string> = {
    name: (debtor.owner_name || debtor.tenant_name || '').trim(),
    debt: formatDebt(debtor.total_debt ?? 0),
    apartment: (debtor.apartment_number ?? '').trim(),
    building_name: (debtor.building_name ?? debtor.address ?? '').trim(),
  };

  return content.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );
}

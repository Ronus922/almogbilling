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
  /** {{apartment}} — apartment number (`apartment_number`). */
  apartment_number?: string | null;
  /** {{debt}} — total debt (`total_debt`). */
  total_debt?: number | null;
  /** {{monthly}} — monthly management-fee debt. In proj_billing this is the
   *  `management_fees` numeric column; `monthly_debt` is a TEXT month-range
   *  ("7/25 - 6/26") from the Bllink sync, NOT a money value. */
  management_fees?: number | null;
  /** {{special}} — the special/hot-water debt. Bllink's "special_debt" column
   *  is written to billing's `hot_water_debt`; this is the ONLY live source. */
  hot_water_debt?: number | null;
  /** LEGACY fallback for {{special}} — billing's `special_debt` column is
   *  all-zero (the import zeroes it and nothing feeds it). Only consulted when
   *  `hot_water_debt` is absent, so an unmigrated payload behaves as before. */
  // TODO: הסר את ה-fallback ל-special_debt עם ה-DROP ב-Phase B
  special_debt?: number | null;
}

/** Supported placeholders — also drives the insert buttons in the composer.
 *  {{total_debt}}/{{total_monthly}}/{{total_special}} are the recommended way
 *  to reference a broadcast recipient's grand total across all their
 *  apartments — see interpolateBroadcastTemplate. */
export const TEMPLATE_PLACEHOLDERS: ReadonlyArray<{ token: string; label: string }> = [
  { token: '{{name}}',          label: 'שם הדייר' },
  { token: '{{apartment}}',     label: 'דירה' },
  { token: '{{debt}}',          label: 'סה״כ חוב' },
  { token: '{{monthly}}',       label: 'דמי ניהול' },
  { token: '{{special}}',       label: 'חוב מיוחד' },
  { token: '{{total_debt}}',    label: 'סה״כ חוב (כל הדירות)' },
  { token: '{{total_monthly}}', label: 'סה״כ דמי ניהול (כל הדירות)' },
  { token: '{{total_special}}', label: 'סה״כ חוב מיוחד (כל הדירות)' },
] as const;

/** Strips separator chars ("/", ",") and whitespace from the edges — shared
 *  by resolveName (single apartment) and resolveConsolidatedName (several). */
function cleanNameCandidate(v: string | null | undefined): string {
  return (v ?? '').replace(/^[\s\/,]+|[\s\/,]+$/g, '').trim();
}

/** owner_name → tenant_name (first non-empty), trimmed. Empty → "דייר יקר". */
function resolveName(debtor: TemplateDebtor): string {
  return cleanNameCandidate(debtor.owner_name) || cleanNameCandidate(debtor.tenant_name) || 'דייר יקר';
}

/**
 * {{name}} for a broadcast recipient consolidated across several apartments
 * (same phone, e.g. an owner with 2 units, or an operator managing dozens).
 * Each apartment contributes ONE raw name candidate (already
 * owner-vs-tenant-resolved by the caller for that apartment's role) —
 *   0 distinct non-empty names  → "דייר יקר" (same "no name anywhere" default
 *                                  as the single-apartment resolveName)
 *   1 distinct non-empty name   → that name (all apartments agree)
 *   2+ distinct non-empty names → "" (genuine conflict — e.g. the same phone
 *                                  is "אפרים וחנה אהרון" on one apartment and
 *                                  "זהבה ניישטיין" on another; a real person's
 *                                  name should never be guessed wrong, so the
 *                                  greeting stays neutral instead)
 */
export function resolveConsolidatedName(rawNames: ReadonlyArray<string | null | undefined>): string {
  const distinct = Array.from(new Set(rawNames.map(cleanNameCandidate).filter((n) => n.length > 0)));
  if (distinct.length === 0) return 'דייר יקר';
  if (distinct.length === 1) return distinct[0];
  return '';
}

/**
 * Replaces `{{placeholder}}` tokens with the debtor's values.
 *   {{name}}    → owner_name || tenant_name (cleaned) | "דייר יקר"
 *   {{debt}}    → formatted total_debt (₪ + thousands)
 *   {{monthly}} → formatted management_fees
 *   {{special}} → formatted hot_water_debt (falls back to legacy special_debt)
 * Money is formatted with Intl.NumberFormat('he-IL') + ₪; null → ₪ 0.
 * An UNKNOWN placeholder is left verbatim (e.g. "{{foo}}" stays "{{foo}}").
 */
export function interpolateTemplate(content: string, debtor: TemplateDebtor): string {
  const values: Record<string, string> = {
    name: resolveName(debtor),
    apartment: (debtor.apartment_number ?? '').trim(),
    debt: formatDebt(debtor.total_debt ?? 0),
    monthly: formatDebt(debtor.management_fees ?? 0),
    special: formatDebt(debtor.hot_water_debt ?? debtor.special_debt ?? 0),
  };

  return content.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );
}

// ── Repeating apartment block — a broadcast recipient with several
// apartments (same phone) gets ONE consolidated message, not one per
// apartment. The template author marks the part that repeats by wrapping it
// in {{#apartments}}...{{/apartments}}; the system renders that part once per
// apartment and splices it in where it was, leaving the opening/closing text
// untouched. No block at all → renders exactly like interpolateTemplate
// (single-apartment templates are completely unaffected). ──────────────────

export const APARTMENTS_BLOCK_OPEN = '{{#apartments}}';
export const APARTMENTS_BLOCK_CLOSE = '{{/apartments}}';

/** A money/debt token — its presence (or the block markers) is what makes a
 *  template a "debt message" (see isDebtMessageTemplate) and routes it through
 *  the per-apartment consolidation engine. {{name}} alone does NOT count:
 *  several historical broadcasts (plain announcements) use only {{name}} and
 *  must keep routing through the untouched single-value path.
 *
 *  {{apartment}} alone (no money token) also does NOT count, as of PR ב' — a
 *  template like "יש תקלה בדירה {{apartment}}, אנא פנו למשרד" doesn't need a
 *  debt breakdown, only ONE apartment number, so consolidating it would be
 *  pure overhead. It stays on the free-form path (one message per phone,
 *  {{apartment}} = whichever apartment happened to resolve first for that
 *  phone) — exactly the pre-existing interpolateTemplate behavior, unchanged
 *  by this feature. A template that mixes {{apartment}} WITH a money token
 *  (e.g. "לדירה {{apartment}}: {{debt}}") IS a debt message, and bare
 *  {{apartment}} outside a repeating block in a debt message for a
 *  multi-apartment recipient is still blocked at campaign creation — see
 *  templateUsesApartmentOutsideBlock. */
const DEBT_TOKENS = new Set([
  'debt', 'monthly', 'special',
  'total_debt', 'total_monthly', 'total_special',
]);

function extractTemplateTokens(content: string): Set<string> {
  const tokens = new Set<string>();
  content.replace(/\{\{(\w+)\}\}/g, (full, key: string) => { tokens.add(key); return full; });
  return tokens;
}

/** True if `content` needs the multi-apartment broadcast engine (a money/debt
 *  token, or a repeating block) rather than the plain single-value
 *  interpolateTemplate path. See DEBT_TOKENS for why bare {{apartment}} does
 *  not, on its own, trigger this. */
export function isDebtMessageTemplate(content: string): boolean {
  if (content.includes(APARTMENTS_BLOCK_OPEN) || content.includes(APARTMENTS_BLOCK_CLOSE)) return true;
  for (const token of extractTemplateTokens(content)) if (DEBT_TOKENS.has(token)) return true;
  return false;
}

/** True if a DEBT-classified template (see isDebtMessageTemplate) uses bare
 *  {{apartment}} outside its repeating block (or has no block at all). Used
 *  only at campaign-creation time, together with a check for any recipient
 *  having >1 apartment, to hard-block an ambiguous send — see the PR ב'
 *  campaign route. Assumes `content` already passed parseApartmentsBlock. */
export function templateUsesApartmentOutsideBlock(content: string): boolean {
  const parsed = parseApartmentsBlock(content);
  const outside = parsed.ok && parsed.block ? parsed.block.prefix + parsed.block.suffix : content;
  return extractTemplateTokens(outside).has('apartment');
}

export interface ApartmentsBlockParts {
  prefix: string;
  blockTemplate: string;
  suffix: string;
}

export interface ApartmentsBlockValidation {
  ok: boolean;
  /** Hebrew, set only when !ok — surfaced verbatim by the template editor
   *  (blocks save) and by campaign creation (blocks the campaign). */
  error?: string;
  /** The parsed block, or null when there is no block at all (ok=true, the
   *  template behaves like a plain single-value template) or the block is
   *  invalid (ok=false). */
  block: ApartmentsBlockParts | null;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

/** Parses (and validates) the template's single optional repeating block.
 *  Reused by both the template editor (live validation, blocks save) and
 *  campaign creation (blocks the campaign) — same rules, same Hebrew text. */
export function parseApartmentsBlock(content: string): ApartmentsBlockValidation {
  const openCount = countOccurrences(content, APARTMENTS_BLOCK_OPEN);
  const closeCount = countOccurrences(content, APARTMENTS_BLOCK_CLOSE);

  if (openCount === 0 && closeCount === 0) return { ok: true, block: null };
  if (openCount > 1 || closeCount > 1) {
    return { ok: false, error: 'מותר קטע חוזר אחד בלבד בתבנית.', block: null };
  }
  if (openCount === 1 && closeCount === 0) {
    return {
      ok: false,
      error: 'הקטע החוזר ({{#apartments}}) נפתח אך לא נסגר. הוסיפו {{/apartments}} בסוף החלק שחוזר לכל דירה.',
      block: null,
    };
  }
  if (openCount === 0 && closeCount === 1) {
    return { ok: false, error: 'נמצאה סגירת קטע ({{/apartments}}) ללא פתיחה תואמת.', block: null };
  }

  const openIdx = content.indexOf(APARTMENTS_BLOCK_OPEN);
  const closeIdx = content.indexOf(APARTMENTS_BLOCK_CLOSE);
  if (closeIdx < openIdx) {
    return { ok: false, error: 'סדר הסימונים הפוך — {{/apartments}} מופיע לפני {{#apartments}}.', block: null };
  }

  return {
    ok: true,
    block: {
      prefix: content.slice(0, openIdx),
      blockTemplate: content.slice(openIdx + APARTMENTS_BLOCK_OPEN.length, closeIdx),
      suffix: content.slice(closeIdx + APARTMENTS_BLOCK_CLOSE.length),
    },
  };
}

/** One apartment's debt breakdown, for the repeating {{#apartments}} block. */
export interface ApartmentDebtEntry {
  apartment_number: string;
  total_debt?: number | null;
  management_fees?: number | null;
  hot_water_debt?: number | null;
  special_debt?: number | null;
}

/** A broadcast recipient consolidated across 1+ apartments sharing one phone.
 *  `name` is already resolved by the caller — see resolveConsolidatedName. */
export interface BroadcastTemplateRecipient {
  name: string;
  apartments: ReadonlyArray<ApartmentDebtEntry>;
}

export interface BroadcastRenderResult {
  text: string;
  truncated: boolean;
  shownApartments: number;
  totalApartments: number;
  /** Apartment numbers NOT individually itemized (empty unless truncated). */
  cutApartmentNumbers: string[];
}

/** Concatenated per-apartment block text past this length triggers
 *  truncation — see the "ועוד X דירות" summary line below. Measured on the
 *  largest real operator today (40 apartments, ~76 chars/block ≈ 3,111 chars
 *  total): comfortably under the 4,096 message-body limit, but close enough
 *  that a defensive cap belongs in this PR rather than a future one. */
const APARTMENTS_TRUNCATE_BUDGET_CHARS = 3000;

function sumBy(
  items: ReadonlyArray<ApartmentDebtEntry>,
  pick: (a: ApartmentDebtEntry) => number | null | undefined,
): number {
  return items.reduce((sum, a) => sum + (pick(a) ?? 0), 0);
}

/** Exported for reuse by campaign creation, which needs the SAME ascending
 *  order to pick a consolidated recipient's representative apartment
 *  (contact_id/debtor_id on its wa_campaign_recipients row) — the lowest
 *  apartment number, matching the block's own rendering order. Generic so a
 *  caller's richer apartment shape (e.g. whatsapp-broadcast.ts's
 *  ConsolidatedApartment, which also carries contactId/debtorId) round-trips
 *  without losing its extra fields to ApartmentDebtEntry's narrower type. */
export function sortByApartmentNumberAscending<T extends ApartmentDebtEntry>(
  apartments: ReadonlyArray<T>,
): T[] {
  return [...apartments].sort((a, b) => {
    const na = Number(a.apartment_number);
    const nb = Number(b.apartment_number);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.apartment_number.localeCompare(b.apartment_number);
  });
}

/** Substitutes `{{token}}` from `values`. {{name}} gets special treatment:
 *  when it resolves empty (conflicting names — resolveConsolidatedName), an
 *  immediately-following comma is swallowed too, so "שלום {{name}}," doesn't
 *  leave a dangling "שלום ,". An unknown token is left verbatim, same as
 *  interpolateTemplate. Whitespace is NOT normalized here — done once on the
 *  final assembled message, not per fragment (see normalizeGaps). */
function substitute(text: string, values: Record<string, string>): string {
  let out = text.replace(/\{\{name\}\}(,)?/g, (full, comma: string | undefined) =>
    values.name === '' ? '' : values.name + (comma ?? ''),
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : full,
  );
  return out;
}

/** Collapses runs of 2+ spaces/tabs within each line (never touches
 *  newlines) and trims trailing space before a line break — cosmetic cleanup
 *  for the gap an empty {{name}} (or a skipped summary line) can leave. */
function normalizeGaps(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''))
    .join('\n');
}

/**
 * Renders a broadcast message for a recipient consolidated across 1+
 * apartments. No {{#apartments}} block in `content` → behaves exactly like
 * interpolateTemplate (single value everywhere; for >1 apartments,
 * {{debt}}/{{monthly}}/{{special}} fall back to the grand total for backward
 * compatibility, and {{apartment}} is blank — the real prevention of that
 * ambiguous case is the campaign-creation gate, this is only a safety net).
 *
 * With a block: the part between the markers is rendered once per apartment
 * (ascending apartment_number) using THAT apartment's own values, and
 * concatenated in place of the block. Text outside the block sees the grand
 * totals ({{total_debt}} etc., and {{debt}} etc. for backward compatibility).
 * Beyond APARTMENTS_TRUNCATE_BUDGET_CHARS of itemized apartments, the rest
 * are summarized in one line instead of itemized (see BroadcastRenderResult).
 *
 * Assumes `content`'s block (if any) already passed parseApartmentsBlock —
 * an invalid block renders as if there were none (defensive fallback; the
 * real gate is at campaign creation).
 */
export function interpolateBroadcastTemplate(
  content: string,
  recipient: BroadcastTemplateRecipient,
): BroadcastRenderResult {
  const apartments = sortByApartmentNumberAscending(recipient.apartments);
  const totalDebt = sumBy(apartments, (a) => a.total_debt);
  const totalMonthly = sumBy(apartments, (a) => a.management_fees);
  const totalSpecial = sumBy(apartments, (a) => a.hot_water_debt ?? a.special_debt);

  const outsideValues: Record<string, string> = {
    name: recipient.name,
    total_debt: formatDebt(totalDebt),
    total_monthly: formatDebt(totalMonthly),
    total_special: formatDebt(totalSpecial),
    // Backward compatibility: outside a block, these mean "grand total" —
    // an existing template with no block "just works" for a multi-apartment
    // recipient instead of showing one arbitrary apartment's numbers.
    debt: formatDebt(totalDebt),
    monthly: formatDebt(totalMonthly),
    special: formatDebt(totalSpecial),
    // No single value make sense for >1 apartments — blank is the
    // defensive fallback; the campaign-creation gate is the real guard.
    apartment: apartments.length === 1 ? apartments[0].apartment_number : '',
  };

  const parsed = parseApartmentsBlock(content);
  const block = parsed.ok ? parsed.block : null;

  if (!block) {
    return {
      text: normalizeGaps(substitute(content, outsideValues)),
      truncated: false,
      shownApartments: apartments.length,
      totalApartments: apartments.length,
      cutApartmentNumbers: [],
    };
  }

  const shown: ApartmentDebtEntry[] = [];
  let blocksRendered = '';
  for (const apt of apartments) {
    const aptValues: Record<string, string> = {
      ...outsideValues,
      apartment: apt.apartment_number,
      debt: formatDebt(apt.total_debt),
      monthly: formatDebt(apt.management_fees),
      special: formatDebt(apt.hot_water_debt ?? apt.special_debt),
    };
    const rendered = substitute(block.blockTemplate, aptValues);
    if (blocksRendered.length + rendered.length > APARTMENTS_TRUNCATE_BUDGET_CHARS && shown.length > 0) break;
    blocksRendered += rendered;
    shown.push(apt);
  }

  const cut = apartments.slice(shown.length);
  let summaryLine = '';
  if (cut.length > 0) {
    const cutTotal = formatDebt(sumBy(cut, (a) => a.total_debt));
    if (cut.length <= 3) {
      const noun = cut.length === 1 ? 'דירה' : 'דירות';
      summaryLine = `ועוד ${noun} ${cut.map((a) => a.apartment_number).join(', ')}, סה"כ ${cutTotal}`;
    } else {
      summaryLine = `ועוד ${cut.length} דירות נוספות, סה"כ ${cutTotal}`;
    }
  }

  const text = substitute(block.prefix, outsideValues)
    + blocksRendered
    + (summaryLine ? `${summaryLine}\n` : '')
    + substitute(block.suffix, outsideValues);

  return {
    text: normalizeGaps(text),
    truncated: cut.length > 0,
    shownApartments: shown.length,
    totalApartments: apartments.length,
    cutApartmentNumbers: cut.map((a) => a.apartment_number),
  };
}

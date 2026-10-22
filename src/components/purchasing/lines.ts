// Client-side model of the lines editor: numbers are kept as TEXT while typing
// ("12." must survive), and converted — and validated — once, on save.
import { computeTotals, PURCHASING_LIMITS, type PricedLine } from '@/lib/purchasing/model';

export interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unit_price: string;
}

let seq = 0;
export const newLineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;
export const emptyLine = (): LineDraft => ({ key: newLineKey(), description: '', quantity: '1', unit_price: '' });

/** Accepts "1,250.5" / "1250,5" the way an Israeli keyboard produces them. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return null;
  const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export interface LinePayload {
  description: string;
  quantity: number;
  unit_price: number | null;
}

/** Drafts → the API shape, or the first problem in Hebrew. Blank rows (no
 *  description, no price) are dropped, so the trailing empty row is harmless. */
export function draftsToPayload(
  drafts: readonly LineDraft[],
  priceRequired: boolean,
): { ok: true; lines: LinePayload[] } | { ok: false; error: string; key?: string } {
  const used = drafts.filter((d) => d.description.trim() || d.unit_price.trim());
  if (used.length === 0) return { ok: false, error: 'יש להוסיף לפחות שורה אחת' };
  const lines: LinePayload[] = [];
  for (const d of used) {
    const description = d.description.trim();
    if (!description) return { ok: false, error: 'יש להזין פירוט בכל שורה', key: d.key };
    if (description.length > PURCHASING_LIMITS.descriptionMax) return { ok: false, error: 'הפירוט ארוך מדי', key: d.key };
    const quantity = parseNumber(d.quantity);
    if (quantity === null || quantity <= 0) return { ok: false, error: 'כמות חייבת להיות גדולה מ-0', key: d.key };
    // The price is required in a purchase order, optional in a request (blank = none).
    let unit_price: number | null = null;
    if (priceRequired || d.unit_price.trim()) {
      unit_price = parseNumber(d.unit_price);
      if (unit_price === null || unit_price < 0) return { ok: false, error: priceRequired ? 'יש להזין מחיר בכל שורה' : 'המחיר אינו תקין', key: d.key };
    }
    lines.push({ description, quantity, unit_price });
  }
  return { ok: true, lines };
}

/** Live totals while editing (rows that are not yet valid count as 0). */
export function draftTotals(drafts: readonly LineDraft[], vatRate: number) {
  const priced: PricedLine[] = drafts.map((d) => ({
    quantity: parseNumber(d.quantity) ?? 0,
    unit_price: parseNumber(d.unit_price) ?? 0,
  }));
  return computeTotals(priced, vatRate);
}

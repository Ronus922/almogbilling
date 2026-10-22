// Purchasing ("רכש") — the pure, isomorphic core: document types, the money
// arithmetic, the quote comparison and the file rules. No I/O, so the screen,
// the PDF and the routes compute totals with the SAME code and cannot drift.

export const DOC_TYPES = ['rfq', 'po'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_LABEL: Record<DocType, string> = {
  rfq: 'בקשה להצעת מחיר',
  po: 'הזמנת רכש',
};

/** "הזמנת רכש מספר 12" / "בקשה להצעת מחיר מספר 3" — the PDF title and the UI. */
export function docHeading(type: DocType, number: number): string {
  return `${DOC_LABEL[type]} מספר ${number}`;
}

export const DEFAULT_VAT_RATE = 18;

/** The key of a party in the API and the screens: a listed supplier's uuid, or
 *  this literal for the ONE hand-typed supplier of a document (it has no row in
 *  `suppliers`; its details ride on the document / recipient / quote). */
export const MANUAL_PARTY = 'manual';
export const partyKey = (p: { supplier_id: string | null }): string => p.supplier_id ?? MANUAL_PARTY;

export const PURCHASING_LIMITS = {
  maxLines: 500,
  descriptionMax: 500,
  titleMax: 200,
  notesMax: 4000,
  quoteNotesMax: 2000,
  maxQuantity: 999_999_999,
  maxUnitPrice: 99_999_999,
  /** Files attached by staff to a document, and the supplier's per quote. */
  staffFilesMax: 10,
  staffFileBytes: 20 * 1024 * 1024,
  supplierFilesMax: 3,
  supplierFileBytes: 10 * 1024 * 1024,
  /** Branding images (logo, scanned signature). */
  brandImageBytes: 2 * 1024 * 1024,
  maxRecipients: 30,
} as const;

/** Round half away from zero to 2 decimals, immune to binary float noise
 *  (1.005 → 1.01) — all money in this module goes through it. */
export function round2(n: number): number {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

export interface PricedLine {
  quantity: number;
  unit_price: number | null;
}

/** A line's total: quantity × unit price, to the agora. */
export function lineTotal(line: PricedLine): number {
  return round2(line.quantity * (line.unit_price ?? 0));
}

export interface Totals {
  subtotal: number;
  vat: number;
  total: number;
}

/** Sum before VAT, the VAT at `vatRate` percent, and the payable total. */
export function computeTotals(lines: readonly PricedLine[], vatRate: number): Totals {
  const subtotal = round2(lines.reduce((s, l) => s + lineTotal(l), 0));
  const vat = round2((subtotal * vatRate) / 100);
  return { subtotal, vat, total: round2(subtotal + vat) };
}

const ILS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₪1,250.00 — the money format of the documents (DESIGN: ₪ prefix, 2 decimals). */
export function formatIls(n: number): string {
  const v = round2(n);
  return `${v < 0 ? '-' : ''}₪${ILS.format(Math.abs(v))}`;
}

const QTY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
export function formatQty(n: number): string {
  return QTY.format(n);
}

export function formatVatRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0+$/, '')}%`;
}

/** 2026-10-21 → 21/10/2026, without a timezone round-trip. */
export function formatDocDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const STAMP = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** A timestamp as "21/10/2026 14:05" in Israel time (the server stores UTC). */
export function formatStampIL(ts: string | Date | null | undefined): string {
  if (!ts) return '';
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) return '';
  return STAMP.format(d).replace(',', '');
}

/** Today in Israel as YYYY-MM-DD (the server runs in UTC). */
export function todayIsrael(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem' }).format(now);
}

/** A request accepts quotes through its due date (inclusive); the day after,
 *  the supplier's link is read-only. Both are YYYY-MM-DD. */
export function isRfqOpen(dueDate: string, today: string = todayIsrael()): boolean {
  return today <= dueDate.slice(0, 10);
}

// ── Quote comparison ────────────────────────────────────────────────────────

export interface CompareLine {
  id: string;
  description: string;
  quantity: number;
}

export interface CompareQuote {
  supplier_id: string;
  supplier_name: string;
  /** line id → unit price, only for the lines the offer priced. */
  prices: Record<string, number>;
  /** Offer total before VAT when it has no (or partial) line prices. */
  total_amount: number | null;
}

export interface CompareColumn {
  supplier_id: string;
  supplier_name: string;
  /** null = the offer says nothing about this line. */
  unitPrices: Array<number | null>;
  lineTotals: Array<number | null>;
  /** Before VAT. null = no usable price at all. */
  total: number | null;
  /** True when `total` comes from the lump sum and not from the lines. */
  lumpSum: boolean;
  cheapest: boolean;
}

/** The total of one offer: the sum of its lines when it priced EVERY line,
 *  otherwise its stated lump sum (a partially priced offer is compared on its
 *  lump sum only — summing some lines would understate it). */
export function quoteTotal(
  lines: readonly CompareLine[],
  q: Pick<CompareQuote, 'prices' | 'total_amount'>,
): { total: number | null; lumpSum: boolean } {
  const priced = lines.length > 0 && lines.every((l) => q.prices[l.id] !== undefined);
  if (priced) {
    return { total: round2(lines.reduce((s, l) => s + round2(l.quantity * q.prices[l.id]!), 0)), lumpSum: false };
  }
  return q.total_amount !== null ? { total: round2(q.total_amount), lumpSum: true } : { total: null, lumpSum: false };
}

/** One column per offer, the cheapest total(s) flagged. */
export function buildComparison(lines: readonly CompareLine[], quotes: readonly CompareQuote[]): CompareColumn[] {
  const cols = quotes.map((q): CompareColumn => {
    const { total, lumpSum } = quoteTotal(lines, q);
    return {
      supplier_id: q.supplier_id,
      supplier_name: q.supplier_name,
      unitPrices: lines.map((l) => q.prices[l.id] ?? null),
      lineTotals: lines.map((l) => (q.prices[l.id] === undefined ? null : round2(l.quantity * q.prices[l.id]!))),
      total,
      lumpSum,
      cheapest: false,
    };
  });
  const totals = cols.map((c) => c.total).filter((t): t is number => t !== null);
  const min = totals.length ? Math.min(...totals) : null;
  // A single offer is not "the cheapest" of anything.
  if (min !== null && totals.length > 1) for (const c of cols) c.cheapest = c.total === min;
  return cols;
}

/** The per-line cheapest unit price index (for highlighting the cell), or -1. */
export function cheapestLineIndex(cols: readonly CompareColumn[], lineIdx: number): number[] {
  const vals = cols.map((c) => c.unitPrices[lineIdx]);
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length < 2) return [];
  const min = Math.min(...nums);
  return vals.flatMap((v, i) => (v === min ? [i] : []));
}

// ── Files ───────────────────────────────────────────────────────────────────

/** The staff-facing branding images: PNG / JPEG only (jsPDF embeds exactly
 *  those, and an SVG could carry script). */
export function validateBrandImage(file: { name: string; size: number; type?: string }): string | null {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(file.name.trim())?.[1]?.toLowerCase() ?? '';
  if (!['png', 'jpg', 'jpeg'].includes(ext)) return 'יש לבחור תמונה בפורמט PNG או JPG';
  if (file.type && !['image/png', 'image/jpeg'].includes(file.type)) return 'תוכן הקובץ אינו תמונת PNG או JPG';
  if (file.size <= 0) return 'הקובץ ריק';
  if (file.size > PURCHASING_LIMITS.brandImageBytes) return 'התמונה גדולה מ-2MB';
  return null;
}

/** Magic-byte check: the declared type must be what the bytes are. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

// ── Company letterhead ──────────────────────────────────────────────────────

export interface CompanySettings {
  name: string;
  tax_id: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  vat_rate: number;
  /** Storage keys (bucket purchasing-files) or null. */
  logo_key: string | null;
  signature_key: string | null;
}

export const EMPTY_COMPANY: CompanySettings = {
  name: '', tax_id: '', address: '', phone: '', email: '', website: '',
  vat_rate: DEFAULT_VAT_RATE, logo_key: null, signature_key: null,
};

/** The wizard is mandatory until the fields a letterhead cannot do without are
 *  there (the website, the logo and the signature are optional). */
export function companyIsComplete(c: CompanySettings | null): boolean {
  return !!c && !!c.name.trim() && !!c.tax_id.trim() && !!c.address.trim() && !!c.phone.trim() && !!c.email.trim();
}

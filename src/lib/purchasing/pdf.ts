import 'server-only';
import { jsPDF } from 'jspdf';
import { registerHeebo } from '@/lib/pdf-heebo';
import { HEEBO_BOLD_BASE64 } from '@/lib/pdf-heebo-bold';
import { toVisual, wrapLogical } from './bidi';
import {
  computeTotals, docHeading, formatDocDate, formatIls, formatQty, formatVatRate, lineTotal, sniffImage,
  type CompanySettings, type DocType,
} from './model';

// The A4 letterhead PDF of a request for quotation / purchase order. Server
// side (the same bytes are downloaded, e-mailed and sent over WhatsApp).
//
// Layout (right-to-left; the layout follows Ronen's samples):
//   top-right   company name (bold) + address / tel / tax id / site / e-mail
//   top-left    logo
//   ───────── rule
//   right "לכבוד:" supplier name, address, phone       left  date
//   right title "הזמנת רכש מספר N"                      left  "מקור"
//   table  פירוט · כמות · מחיר · סה״כ  (alternating rows)   (RFQ: only if a price was entered)
//   totals סה״כ לפני מע״מ / מע״מ X% / סה״כ לתשלום (bold)  (when prices are shown)
//   "חתימה:" + the scanned signature
//
// jsPDF paints left-to-right with no bidi, so every string is wrapped on its
// LOGICAL text and then ordered with toVisual() (bidi.ts): numbers, e-mail and
// English words keep their reading order inside Hebrew lines.

export interface PdfLine {
  description: string;
  quantity: number;
  unit_price: number | null;
}

export interface PdfSupplier {
  name: string;
  address: string;
  phone: string;
}

export interface PdfInput {
  kind: DocType;
  number: number;
  date: string; // YYYY-MM-DD
  title: string;
  notes: string;
  /** rfq: last day for quotes. */
  dueDate: string | null;
  vatRate: number;
  company: CompanySettings;
  logo: Uint8Array | null;
  signature: Uint8Array | null;
  /** null = a generic copy (a request downloaded before it is sent). */
  supplier: PdfSupplier | null;
  lines: readonly PdfLine[];
}

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 15;
const RIGHT = PAGE_W - MARGIN; // x of the right edge (RTL start)
const LEFT = MARGIN;
const INK: [number, number, number] = [26, 34, 51];
const MUTED: [number, number, number] = [100, 116, 139];
const RULE: [number, number, number] = [203, 213, 225];
const HEAD_FILL: [number, number, number] = [226, 232, 240];
const ROW_FILL: [number, number, number] = [244, 247, 251];

function registerFonts(doc: jsPDF): void {
  registerHeebo(doc); // normal (and the legacy bold alias)
  // Real bold: re-register the 'bold' style on the Bold outlines.
  doc.addFileToVFS('Heebo-Bold.ttf', HEEBO_BOLD_BASE64);
  doc.addFont('Heebo-Bold.ttf', 'Heebo', 'bold');
  doc.setFont('Heebo', 'normal');
}

function imageFormat(bytes: Uint8Array): 'PNG' | 'JPEG' | null {
  const kind = sniffImage(bytes);
  return kind === 'png' ? 'PNG' : kind === 'jpeg' ? 'JPEG' : null;
}

/** Draws an image inside a box, preserving its aspect ratio, anchored at the
 *  box's left or right edge. Silently skips an unreadable image — a bad logo
 *  must never stop a purchase order from being produced. */
function drawFitted(
  doc: jsPDF, bytes: Uint8Array | null, box: { x: number; y: number; w: number; h: number }, anchor: 'left' | 'right',
): number {
  if (!bytes) return 0;
  const fmt = imageFormat(bytes);
  if (!fmt) return 0;
  try {
    const props = doc.getImageProperties(bytes);
    const scale = Math.min(box.w / props.width, box.h / props.height);
    const w = props.width * scale;
    const h = props.height * scale;
    const x = anchor === 'left' ? box.x : box.x + box.w - w;
    doc.addImage(bytes, fmt, x, box.y, w, h);
    return h;
  } catch {
    return 0;
  }
}

export function renderDocumentPdf(input: PdfInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  registerFonts(doc);
  doc.setProperties({ title: `${docHeading(input.kind, input.number)}` });

  const measure = (size: number, bold = false) => (s: string) => {
    doc.setFont('Heebo', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.getTextWidth(s);
  };
  // Paints one logical string, right-aligned at x (RTL) or left-aligned.
  const put = (text: string, x: number, y: number, o: { size?: number; bold?: boolean; align?: 'right' | 'left' | 'center'; color?: [number, number, number] } = {}) => {
    doc.setFont('Heebo', o.bold ? 'bold' : 'normal');
    doc.setFontSize(o.size ?? 10);
    doc.setTextColor(...(o.color ?? INK));
    // jsPDF post-processes every string with its own bidi engine. The text is
    // already in visual order (toVisual), so tell it input AND output are visual
    // — otherwise it reverses the digits and Latin runs a second time.
    doc.text(toVisual(text), x, y, { align: o.align ?? 'right', isInputVisual: true, isOutputVisual: true });
  };
  // A purchase order always carries prices; a request only when a price was filled in.
  const withPrices = input.kind === 'po' || input.lines.some((l) => l.unit_price !== null);

  // ── Letterhead ────────────────────────────────────────────────────────────
  let y = 18;
  put(input.company.name, RIGHT, y, { size: 17, bold: true });
  const head: string[] = [];
  if (input.company.address) head.push(input.company.address);
  if (input.company.phone) head.push(`טל׳ ${input.company.phone}`);
  if (input.company.tax_id) head.push(`ח.פ. ${input.company.tax_id}`);
  if (input.company.website) head.push(input.company.website);
  if (input.company.email) head.push(input.company.email);
  y += 6;
  for (const h of head) { put(h, RIGHT, y, { size: 10, color: MUTED }); y += 5; }

  const logoH = drawFitted(doc, input.logo, { x: LEFT, y: 12, w: 50, h: 26 }, 'left');
  y = Math.max(y, 12 + logoH) + 1;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.4);
  doc.line(LEFT, y, RIGHT, y);
  y += 8;

  // ── Addressee + date ──────────────────────────────────────────────────────
  const top = y;
  put('לכבוד:', RIGHT, y, { size: 11, bold: true });
  y += 6;
  const to = input.supplier;
  if (to) {
    put(to.name, RIGHT, y, { size: 11, bold: true }); y += 5.5;
    if (to.address) { put(to.address, RIGHT, y, { size: 10 }); y += 5; }
    if (to.phone) { put(`טל׳ ${to.phone}`, RIGHT, y, { size: 10 }); y += 5; }
  } else {
    put(input.kind === 'rfq' ? 'ספקים נכבדים' : '—', RIGHT, y, { size: 11, bold: true });
    y += 5.5;
  }
  put(`תאריך: ${formatDocDate(input.date)}`, LEFT, top + 6, { size: 10, align: 'left' });
  y += 5;

  // ── Title ─────────────────────────────────────────────────────────────────
  put(docHeading(input.kind, input.number), RIGHT, y, { size: 16, bold: true });
  put('מקור', LEFT, y, { size: 12, bold: true, align: 'left' });
  y += 8;
  if (input.title.trim()) {
    for (const ln of wrapLogical(`הנדון: ${input.title.trim()}`, measure(11, true), RIGHT - LEFT)) {
      put(ln, RIGHT, y, { size: 11, bold: true });
      y += 5.5;
    }
    y += 1;
  }
  if (input.kind === 'rfq' && input.dueDate) {
    put(`נא להגיש הצעה עד ${formatDocDate(input.dueDate)}`, RIGHT, y, { size: 10.5, bold: true });
    y += 7;
  }

  // ── Table ─────────────────────────────────────────────────────────────────
  // Widths from the right edge going left (RTL column order).
  const cols = withPrices
    ? [
        { key: 'desc', label: 'פירוט', w: 96 },
        { key: 'qty', label: 'כמות', w: 24 },
        { key: 'price', label: 'מחיר', w: 30 },
        { key: 'total', label: 'סה״כ', w: 30 },
      ]
    : [
        { key: 'desc', label: 'פירוט', w: 150 },
        { key: 'qty', label: 'כמות', w: 30 },
      ];
  const xRight: number[] = [];
  let cursor = RIGHT;
  for (const c of cols) { xRight.push(cursor); cursor -= c.w; }
  const PAD = 2.5;
  const LINE_H = 5;

  const drawHeader = () => {
    doc.setFillColor(...HEAD_FILL);
    doc.rect(LEFT, y, RIGHT - LEFT, 8, 'F');
    cols.forEach((c, i) => {
      if (c.key === 'desc') put(c.label, xRight[i] - PAD, y + 5.4, { size: 10, bold: true });
      else put(c.label, xRight[i] - c.w / 2, y + 5.4, { size: 10, bold: true, align: 'center' });
    });
    y += 8;
  };
  drawHeader();

  input.lines.forEach((line, idx) => {
    const wrapped = wrapLogical(line.description, measure(10), cols[0].w - 2 * PAD);
    const rowH = Math.max(1, wrapped.length) * LINE_H + 3.5;
    if (y + rowH > PAGE_H - 30) {
      doc.addPage();
      y = 18;
      drawHeader();
    }
    if (idx % 2 === 1) {
      doc.setFillColor(...ROW_FILL);
      doc.rect(LEFT, y, RIGHT - LEFT, rowH, 'F');
    }
    wrapped.forEach((ln, i) => put(ln, xRight[0] - PAD, y + 5 + i * LINE_H, { size: 10 }));
    const mid = (i: number) => xRight[i] - cols[i].w / 2;
    const base = y + 5;
    put(formatQty(line.quantity), mid(1), base, { size: 10, align: 'center' });
    if (withPrices) {
      put(line.unit_price === null ? '' : formatIls(line.unit_price), mid(2), base, { size: 10, align: 'center' });
      put(line.unit_price === null ? '' : formatIls(lineTotal(line)), mid(3), base, { size: 10, align: 'center' });
    }
    y += rowH;
  });
  doc.setDrawColor(...RULE);
  doc.line(LEFT, y, RIGHT, y);
  y += 6;

  // ── Totals (when the table shows prices) ──────────────────────────────────────────
  if (withPrices) {
    const t = computeTotals(input.lines, input.vatRate);
    if (y + 28 > PAGE_H - 30) { doc.addPage(); y = 18; }
    const bx = LEFT; // the box hugs the left edge, under the amount columns
    const bw = 78;
    const row = (label: string, value: string, o: { bold?: boolean; size?: number } = {}) => {
      put(label, bx + bw - PAD, y, { size: o.size ?? 10.5, bold: o.bold });
      put(value, bx + PAD, y, { size: o.size ?? 10.5, bold: o.bold, align: 'left' });
      y += 6.5;
    };
    row('סה״כ לפני מע״מ', formatIls(t.subtotal));
    row(`מע״מ ${formatVatRate(input.vatRate)}`, formatIls(t.vat));
    doc.setDrawColor(...INK);
    doc.setLineWidth(0.3);
    doc.line(bx, y - 4, bx + bw, y - 4);
    row('סה״כ לתשלום', formatIls(t.total), { bold: true, size: 12 });
    y += 2;
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (input.notes.trim()) {
    const body = wrapLogical(input.notes.trim(), measure(10), RIGHT - LEFT);
    if (y + 12 > PAGE_H - 30) { doc.addPage(); y = 18; }
    put('הערות:', RIGHT, y, { size: 10.5, bold: true });
    y += 5.5;
    for (const ln of body) {
      if (y > PAGE_H - 30) { doc.addPage(); y = 18; }
      put(ln, RIGHT, y, { size: 10 });
      y += 5;
    }
    y += 3;
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  if (y + 30 > PAGE_H - 12) { doc.addPage(); y = 18; }
  y += 6;
  put('חתימה:', RIGHT, y + 4, { size: 11, bold: true });
  drawFitted(doc, input.signature, { x: RIGHT - 18 - 55, y: y - 4, w: 55, h: 22 }, 'right');

  // ── Footer: page numbers ──────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    put(`עמוד ${p} מתוך ${pages}`, PAGE_W / 2, PAGE_H - 8, { size: 8.5, color: MUTED, align: 'center' });
  }

  return Buffer.from(doc.output('arraybuffer'));
}

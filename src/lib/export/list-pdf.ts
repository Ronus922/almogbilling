import type { jsPDF } from 'jspdf';
import { toVisual, wrapLogical } from '@/lib/purchasing/bidi';

// A list as an A4 PDF file — "הורדה ל-PDF" of /chips (25/11/2026; both tabs).
// Built in the browser from the rows the tab already holds, with the stack the
// project's other PDF files use: jsPDF + the embedded Heebo subsets
// (pdf-heebo.ts, pdf-heebo-bold.ts) + the bidi of the purchasing documents
// (purchasing/bidi.ts). Nothing is fetched and no library was added.
//
// jsPDF paints glyphs left to right. Handed a Hebrew line with a phone number
// in it, its own text post-processing mirrors one of the two. So, as in
// purchasing/pdf.ts, a cell is wrapped on its LOGICAL text, every line is put
// in visual order by toVisual() — a number, a phone, a date and an English
// word keep their reading order — and jsPDF is told that what it gets is
// already visual on both sides. This is also why the table is drawn here by
// hand and not by jspdf-autotable (what the debtors table's PDF uses):
// autotable calls doc.text itself, with no way to pass those two flags.
// Measured on 25/11/2026 by reading the painted glyphs back from the file:
// with autotable a Hebrew word and a number in one cell changed places.
//
// Page: A4 on its side, right to left — the first column is the right-most.
// Heading: the list's title and when the file was made, then what it holds
// (how many rows, the filter in force). Table: a header row on every page,
// rows that never split over two pages, column widths from what the cells
// hold (a date with its time, a phone or a number stays on one line; long
// text wraps on whole words). Footer:
// "עמוד X מתוך Y" on every page.

export interface ListPdfInput {
  /** The heading — the tab's name. */
  title: string;
  /** When the file was made, as text ("24/11/2026 22:15"). */
  date: string;
  /** What the file holds: the number of rows, the filter in force. */
  meta: string[];
  /** Right to left: the first column is the right-most. */
  columns: ListPdfColumn[];
  /** One text per column, in logical (reading) order. */
  rows: string[][];
}

export interface ListPdfColumn {
  header: string;
  /** A phone, a date, a number, a chip number: read left to right, also when
   *  it opens with a sign ("+972…", "-5") — in a right-to-left line the sign
   *  would be drawn on the wrong side of the digits, as a browser draws it.
   *  A cell of such a column that does hold Hebrew (an apartment called
   *  "מחסן 12") is still a Hebrew line, and is drawn right to left. */
  ltr?: boolean;
}

export interface ListPdfFile {
  bytes: ArrayBuffer;
  pages: number;
}

type Rgb = [number, number, number];

const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 12;
const RIGHT = PAGE_W - MARGIN; // where a right-to-left line starts
const LEFT = MARGIN;
const TABLE_W = RIGHT - LEFT;
/** The lowest point a table row may reach; the footer line sits under it. */
const BOTTOM = PAGE_H - 14;
const FOOTER_Y = PAGE_H - 7.5;
const PAD_X = 2;
const PAD_Y = 1.7;
/** Spare width in every column, so a word measured as exactly fitting fits. */
const SLACK = 0.4;
const SIZE = 9;
const LINE_H = 4.3;
/** From the top of a line box down to its baseline, at SIZE. */
const BASELINE = 3.1;
/** A single word may claim this much of the table before it is broken. */
const WORD_CAP = 60;
const INK: Rgb = [26, 34, 51];
const MUTED: Rgb = [100, 116, 139];
const HEAD_INK: Rgb = [51, 65, 85];
const HEAD_FILL: Rgb = [241, 245, 249];
const ROW_FILL: Rgb = [250, 251, 254];
const RULE: Rgb = [226, 232, 240];

// ── Text the embedded fonts can draw ───────────────────────────────────────

/** The glyphs BOTH embedded subsets really carry — read from the fonts' own
 *  maps, not from the ranges they were cut with (Heebo has no glyph for a few
 *  points inside its Hebrew range): basic Latin, the middle dot, the Hebrew
 *  letters and the points Heebo draws, geresh and gershayim, ₪, the two dashes
 *  and the ellipsis. tests/chip-list-export.test.ts paints every one of them
 *  with both fonts, so this class cannot drift away from the font files. */
const DRAWABLE = /^[\u0020-\u007E\u00B7\u05B0-\u05BC\u05BE\u05BF\u05C1\u05C2\u05C7\u05D0-\u05EA\u05F3\u05F4\u20AA\u2013\u2014\u2026]$/;
/** Typography the subsets lack, written with what they have. */
const PLAIN: Record<string, string> = {
  '\u201E': '"', '\u201C': '"', '\u201D': '"', '\u00AB': '"', '\u00BB': '"', // low, curly and angle double quotes
  '\u2018': "'", '\u2019': "'", '\u201A': "'", // curly and low single quotes
  '\u2010': '-', '\u2011': '-', '\u2212': '-', // hyphen, non-breaking hyphen, minus
  '\u2022': '\u00B7', // bullet → middle dot
  '\u00A0': ' ', // no-break space
};
/** A Hebrew letter or point — the line it stands in reads right to left. */
const HEBREW = /[\u0590-\u05FF]/;
/** What is left out without a trace: the marks that only steer a browser's
 *  bidi, zero-width characters, and the three Hebrew points Heebo cannot draw
 *  (meteg and the two dots) — a missing point never changes a name. */
const INVISIBLE = /^[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u05BD\u05C4\u05C5]$/;

/**
 * A text made only of glyphs the embedded fonts hold. Typographic quotes and
 * hyphens become plain ones, invisible marks go, any white space is a space —
 * and a character with no glyph (another script, an emoji) is written as "?".
 * jsPDF would drop such a character without a word; a name must never just
 * vanish from a list someone prints.
 */
export function pdfText(text: string): string {
  let out = '';
  for (const ch of Array.from(text)) {
    if (DRAWABLE.test(ch)) out += ch;
    else if (ch in PLAIN) out += PLAIN[ch];
    else if (INVISIBLE.test(ch)) continue;
    else if (/^\s$/.test(ch)) out += ' ';
    else out += '?';
  }
  return out;
}

// ── Column widths ──────────────────────────────────────────────────────────

/**
 * Column widths from what the columns hold — the browser's own table rule.
 * `full[i]` is the width column i wants with every cell on one line, `word[i]`
 * the width of its longest single word (under that a word would be broken).
 * Everything fits → each column gets its full width and the spare room is
 * shared in proportion. Too wide → every column keeps its longest word, and
 * what is left goes to the columns in proportion to what they still lack.
 */
export function fitColumns(full: number[], word: number[], total: number): number[] {
  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const fullSum = sum(full);
  if (fullSum <= total) return full.map((w) => w + (total - fullSum) * (fullSum > 0 ? w / fullSum : 1 / full.length));
  const wordSum = sum(word);
  // Not even the longest words fit: shrink them all alike (they will break).
  if (wordSum >= total) return word.map((w) => (w * total) / wordSum);
  const lack = full.map((w, i) => w - word[i]!);
  const lackSum = sum(lack);
  return word.map((w, i) => w + ((total - wordSum) * lack[i]!) / lackSum);
}

// ── The file ───────────────────────────────────────────────────────────────

function registerFonts(doc: jsPDF, registerHeebo: (doc: jsPDF) => void, bold: string): void {
  registerHeebo(doc); // normal (and the legacy bold alias)
  // Real bold for the title and the header row: the Bold outlines.
  doc.addFileToVFS('Heebo-Bold.ttf', bold);
  doc.addFont('Heebo-Bold.ttf', 'Heebo', 'bold');
  doc.setFont('Heebo', 'normal');
}

export async function buildListPdf(input: ListPdfInput): Promise<ListPdfFile> {
  // Dynamic imports keep jsPDF and the two font files out of the main bundle.
  const [{ jsPDF: JsPdf }, { registerHeebo }, { HEEBO_BOLD_BASE64 }] = await Promise.all([
    import('jspdf'),
    import('@/lib/pdf-heebo'),
    import('@/lib/pdf-heebo-bold'),
  ]);
  const doc = new JsPdf({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  registerFonts(doc, registerHeebo, HEEBO_BOLD_BASE64);

  const title = pdfText(input.title);
  const date = pdfText(input.date);
  const meta = input.meta.map(pdfText).filter(Boolean).join(' · ');
  const headers = input.columns.map((c) => pdfText(c.header));
  const ltr = input.columns.map((c) => c.ltr === true);
  // An empty cell is a dash, as in the print view.
  const rows = input.rows.map((r) => headers.map((_, i) => pdfText(r[i] ?? '') || '—'));
  doc.setProperties({ title: `${title} ${date}` });

  const measure = (size: number, bold = false) => (s: string) => {
    doc.setFont('Heebo', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.getTextWidth(s);
  };
  // Paints one LOGICAL line: right-aligned at x (right to left), or as asked.
  const put = (
    text: string, x: number, y: number,
    o: { size?: number; bold?: boolean; align?: 'right' | 'left' | 'center'; color?: Rgb; ltr?: boolean } = {},
  ) => {
    doc.setFont('Heebo', o.bold ? 'bold' : 'normal');
    doc.setFontSize(o.size ?? SIZE);
    doc.setTextColor(...(o.color ?? INK));
    // Already in visual order — jsPDF must not reorder it a second time.
    doc.text(toVisual(text, o.ltr ? 'L' : 'R'), x, y, { align: o.align ?? 'right', isInputVisual: true, isOutputVisual: true });
  };

  // Column widths, from the header row (bold) and every cell.
  const widthOf = measure(SIZE);
  const headWidthOf = measure(SIZE, true);
  // (A loop, not Math.max(...cells): a list may run to thousands of rows.)
  const widest = (first: number, cells: (row: string[]) => number) => rows.reduce((max, r) => Math.max(max, cells(r)), first);
  const longestWord = (s: string, w: (t: string) => number) => s.split(/\s+/).filter(Boolean).reduce((max, part) => Math.max(max, w(part)), 0);
  const box = 2 * PAD_X + SLACK;
  const full = headers.map((h, i) => widest(headWidthOf(h), (r) => widthOf(r[i]!)) + box);
  // The least a column may get: its longest word — and in a left-to-right
  // column the whole cell, so a date is never parted from its time.
  const word = headers.map((h, i) =>
    Math.min(WORD_CAP, widest(longestWord(h, headWidthOf), (r) => (ltr[i] ? widthOf(r[i]!) : longestWord(r[i]!, widthOf))) + box));
  const widths = fitColumns(full, word, TABLE_W);
  // The right edge of every column, walking from the page's right edge.
  const edges: number[] = [];
  let cursor = RIGHT;
  for (const w of widths) { edges.push(cursor); cursor -= w; }
  // What a line of column i may take: half the slack stays spare.
  const room = (i: number) => Math.max(1, widths[i]! - 2 * PAD_X - SLACK / 2);

  const headLines = headers.map((h, i) => wrapLogical(h, headWidthOf, room(i)));
  const headH = Math.max(1, ...headLines.map((l) => l.length)) * LINE_H + 2 * PAD_Y;

  let y = 0;
  const drawRow = (lines: string[][], height: number, o: { head?: boolean; fill?: Rgb }) => {
    if (o.fill) {
      doc.setFillColor(...o.fill);
      doc.rect(LEFT, y, TABLE_W, height, 'F');
    }
    lines.forEach((cell, i) => {
      // A header is a Hebrew label, whatever its column holds.
      cell.forEach((line, n) => put(
        line, edges[i]! - PAD_X, y + PAD_Y + BASELINE + n * LINE_H,
        o.head ? { bold: true, color: HEAD_INK } : { ltr: ltr[i] && !HEBREW.test(line) },
      ));
    });
    y += height;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(LEFT, y, RIGHT, y);
  };
  const startPage = (first: boolean) => {
    if (first) {
      put(title, RIGHT, 18, { size: 16, bold: true });
      put(`תאריך הפקה: ${date}`, LEFT, 18, { size: 9.5, color: MUTED, align: 'left' });
      y = 22;
      if (meta) {
        for (const line of wrapLogical(meta, measure(9.5), TABLE_W)) {
          put(line, RIGHT, y + 2.5, { size: 9.5, color: MUTED });
          y += 4.6;
        }
        y += 1.4;
      }
    } else {
      // Every later page says what it belongs to.
      put(`${title} · ${date}`, RIGHT, 13.5, { size: 9, color: MUTED });
      y = 17;
    }
    drawRow(headLines, headH, { head: true, fill: HEAD_FILL });
  };

  startPage(true);
  rows.forEach((r, index) => {
    const lines = r.map((cell, i) => wrapLogical(cell, widthOf, room(i)));
    const height = Math.max(1, ...lines.map((l) => l.length)) * LINE_H + 2 * PAD_Y;
    if (y + height > BOTTOM) {
      doc.addPage();
      startPage(false);
    }
    drawRow(lines, height, index % 2 === 1 ? { fill: ROW_FILL } : {});
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    put(`עמוד ${p} מתוך ${pages}`, PAGE_W / 2, FOOTER_Y, { size: 8.5, color: MUTED, align: 'center' });
  }
  return { bytes: doc.output('arraybuffer'), pages };
}

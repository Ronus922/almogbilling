import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import type { ChipWithHolder } from '@/lib/types/chips';
import { CHIP_ORDERS_EXPORT } from '@/lib/chipOrders/orderRows';
import { CHIPS_EXPORT } from '@/lib/chips/exportColumns';
import { buildListWorkbook, exportCellText, exportFileName, type ListExport } from '@/lib/export/list-export';
import { buildListPdf, fitColumns, pdfText, type ListPdfInput } from '@/lib/export/list-pdf';
import { toVisual } from '@/lib/purchasing/bidi';
import { paintedText } from './helpers/pdf-painted';

// "הדפסה", "ייצוא לאקסל" and "הורדה ל-PDF" of /chips (25/11/2026), both tabs —
// the pure half: the columns of the chips tab, its Excel file read back from
// the real workbook, and the PDF file read back from its real bytes.
//
// The PDF is checked by what is PAINTED, not by what a text extractor returns:
// a Hebrew file is right when every Hebrew word is drawn back to front (the
// glyphs go on the page left to right) while a number, a phone and a date are
// drawn in their reading order. tests/helpers/pdf-painted.ts reads the glyphs
// back in paint order through the embedded font's own map.

const NOW = new Date('2026-11-24T10:00:00Z');
/** A string as it is painted when it reads right to left. */
const rev = (s: string) => Array.from(s).reverse().join('');

function chip(over: Partial<ChipWithHolder>): ChipWithHolder {
  return {
    id: 'c1', chip_number: '0012345678', chip_type: 'physical', contact_id: 'k1', apartment_number: '12', status: 'active',
    resident_role: 'owner', holder_name: 'דנה כהן', holder_phone: '0539300001', issued_at: '2026-11-23T22:30:00Z',
    issued_by: 'u1', issued_by_name: 'מנהל בדיקה', deactivated_at: null, deactivated_by: null, deactivated_by_name: null,
    deactivation_reason: null, controller_synced: false, controller_synced_at: null, app_platform: null,
    app_invite_status: null, app_expires_at: null, issuance_fee: null, fee_charged: false, limit_override_reason: null,
    notes: null, holder_email: null, lease_file_key: null, lease_file_name: null, lease_end_date: null,
    order_item_id: null, reception_record_id: null,
    created_at: '2026-11-23T22:30:00Z', updated_at: '2026-11-23T22:30:00Z',
    live_holder_name: 'דנה כהן', live_holder_phone: '0539300001', holder_chip_count: 1,
    ...over,
  };
}

function order(over: Partial<ChipOrderRow>): ChipOrderRow {
  return {
    item_id: 'i1', order_id: 'o1', order_number: 1042, contact_id: 'k1', apartment_number: '12',
    full_name: 'דנה כהן', phone_e164: '+972539300001', role: 'owner', source: 'web', status: 'paid',
    chips_count: 2, chips_linked: 1, line_total: 100, people: ['דנה כהן', 'שרה לוי'], people_keys: ['h1', 'h2'], extra_of_order_number: null,
    paid_at: '2026-11-23T08:00:00Z', due_at: '2026-11-26T08:00:00Z', created_at: '2026-11-23T07:30:00Z',
    has_failed_notification: false, is_test: false, phone_verified: true,
    ...over,
  };
}

/** The input of the PDF builder for a list — what the buttons hand it. */
function pdfInput<T>(list: ListExport<T>, rows: T[], meta: string[]): ListPdfInput {
  return {
    title: list.title,
    date: '24/11/2026 12:00',
    meta,
    columns: list.columns.map((c) => ({ header: c.header, ltr: c.kind !== 'text' })),
    rows: rows.map((r) => list.columns.map((c) => exportCellText(c, r, NOW))),
  };
}

async function pdfOf(input: ListPdfInput, name: string) {
  const file = await buildListPdf(input);
  const pdf = Buffer.from(file.bytes);
  if (process.env.PDF_OUT_DIR) writeFileSync(`${process.env.PDF_OUT_DIR}/${name}.pdf`, pdf);
  return { pdf, pages: file.pages, painted: paintedText(pdf) };
}

describe('the chips tab as a file', () => {
  it('the columns the table shows — the holder, the apartment and the role side by side', () => {
    expect(CHIPS_EXPORT.columns.map((c) => c.header)).toEqual(['מחזיק', 'דירה', 'תפקיד', 'מספר צ׳יפ', 'סוג', 'סטטוס', 'הונפק', 'מנפיק']);
    expect(CHIPS_EXPORT).toMatchObject({ title: 'צ׳יפים', sheet: 'צ׳יפים', file: 'chips' });
    expect(exportFileName('chips', 'pdf', new Date(2026, 10, 4))).toBe('chips_2026-11-04.pdf');
    expect(exportFileName('chips', 'xlsx', new Date(2026, 0, 31))).toBe('chips_2026-01-31.xlsx');
  });

  it('the workbook: the live registry name, the words of the table, a chip number that stays text', async () => {
    const rows = [
      // The registry name changed since the chip was issued: the table shows the live one.
      chip({ id: 'a', holder_name: 'דנה לוי', live_holder_name: 'דנה כהן' }),
      // A guest has no registry row: the name the chip was issued on.
      chip({
        id: 'b', chip_number: '=1+1', chip_type: 'app', status: 'inactive', resident_role: 'other', apartment_number: '007',
        holder_name: 'אורח מזדמן', live_holder_name: null, issued_by_name: null, issued_at: '2026-09-03T10:00:00Z',
      }),
    ];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildListWorkbook(CHIPS_EXPORT, rows, NOW));
    const ws = wb.worksheets[0]!;
    expect(ws.name).toBe('צ׳יפים');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    const cells = (n: number) => CHIPS_EXPORT.columns.map((_, i) => ws.getRow(n).getCell(i + 1).value);
    expect(cells(1)).toEqual(CHIPS_EXPORT.columns.map((c) => c.header));
    expect(cells(2)).toEqual(['דנה כהן', '12', 'בעל דירה', '0012345678', 'כרטיס', 'פעיל', '24/11/2026', 'מנהל בדיקה']);
    // "אורח" is the screen name of the stored role `other`; a chip number typed
    // like a formula opens as text; nobody on record issued it = a blank cell.
    expect(cells(3)).toEqual(['אורח מזדמן', '007', 'אורח', '\'=1+1', 'אפליקציה', 'לא פעיל', '03/09/2026', null]);
    expect(ws.rowCount).toBe(3);
    // The apartment and the chip number stay text: their leading zeros survive.
    expect(ws.getRow(2).getCell(2).type).toBe(ExcelJS.ValueType.String);
    expect(ws.getRow(2).getCell(4).type).toBe(ExcelJS.ValueType.String);
  });
});

describe('text the embedded fonts can draw', () => {
  it('Hebrew, Latin, digits and the signs of the lists pass as they are', () => {
    const plain = 'דירה 12 · צ׳יפ מס׳ A1-B2 (סה״כ ₪1,250.50) – עד 24/11/2026 — ראו…';
    expect(pdfText(plain)).toBe(plain);
  });

  it('typographic quotes become plain ones, invisible marks go, a character with no glyph is a "?"', () => {
    expect(pdfText('סינון: „דנה”')).toBe('סינון: "דנה"');
    expect(pdfText(`a${String.fromCodePoint(0x200f)}b${String.fromCodePoint(0xa0)}c`)).toBe('ab c');
    expect(pdfText('שורה\tראשונה\nשנייה')).toBe('שורה ראשונה שנייה');
    // Another script and an emoji: one "?" per character — never an empty name.
    expect(pdfText(`${String.fromCodePoint(0x418, 0x432, 0x430, 0x43d)} ${String.fromCodePoint(0x1f600)}`)).toBe('???? ?');
    // Inside the Hebrew block too: a point Heebo cannot draw (meteg) is left
    // out, a sign it cannot draw (sof pasuq) and a code that is no character
    // at all are a "?" — the letters around them stay.
    expect(pdfText(`א${String.fromCodePoint(0x5bd)}ב`)).toBe('אב');
    expect(pdfText(`א${String.fromCodePoint(0x5c3)}ב${String.fromCodePoint(0x5c8)}`)).toBe('א?ב?');
  });

  it('every character it lets through is really painted — by the regular font and by the bold one', async () => {
    // jsPDF leaves out, without a word, a character its font has no glyph for.
    // So: every character pdfText keeps, drawn once as a header (bold) and
    // once as a cell (regular), and read back from the file.
    const kept: string[] = [];
    for (let code = 0x21; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // surrogates are no characters
      const ch = String.fromCodePoint(code);
      if (pdfText(ch) === ch) kept.push(ch);
    }
    expect(kept.length).toBeGreaterThan(130);
    const text = Array.from({ length: Math.ceil(kept.length / 10) }, (_, i) => kept.slice(i * 10, i * 10 + 10).join('')).join(' ');
    const file = await buildListPdf({ title: 'T', date: 'D', meta: [], columns: [{ header: text }], rows: [[text]] });
    const painted = paintedText(Buffer.from(file.bytes));
    expect(painted.every((p) => p.text !== null)).toBe(true);
    // The title is bold, the page number regular: the two fonts of the file.
    const bold = painted.find((p) => p.text === 'T')!.font;
    const regular = painted.find((p) => p.text === `1 ${rev('מתוך')} 1 ${rev('עמוד')}`)!.font;
    expect(bold).not.toBe(regular);
    for (const [name, font] of [['bold', bold], ['regular', regular]] as const) {
      const drawn = new Set(painted.filter((p) => p.font === font).flatMap((p) => Array.from(p.text ?? '')));
      const lost = kept.filter((ch) => !drawn.has(ch)).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
      expect(lost, `characters the ${name} font does not draw`).toEqual([]);
    }
  });
});

describe('column widths from what the columns hold', () => {
  it('everything fits: the full widths, and the spare room shared in proportion', () => {
    expect(fitColumns([10, 30], [5, 10], 80)).toEqual([20, 60]);
  });

  it('too wide: every column keeps its longest word, the rest goes where it is missing', () => {
    const w = fitColumns([100, 50, 20], [30, 10, 20], 100);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(w[2]).toBeCloseTo(20, 6); // a column that asks for nothing more gets nothing more
    expect(w[0]!).toBeGreaterThan(30);
    expect(w[1]!).toBeGreaterThan(10);
  });

  it('not even the longest words fit: all shrink alike', () => {
    expect(fitColumns([90, 90], [60, 60], 100)).toEqual([50, 50]);
  });
});

describe('the PDF file of a list', () => {
  it('the Orders tab: an embedded Hebrew font, the title and the date, right-to-left columns, numbers and phones in reading order, page numbers', async () => {
    const rows = [
      order({}),
      order({
        item_id: 'i2', order_number: 1043, apartment_number: '7', full_name: 'Yossi Mizrahi', phone_e164: '+447911123456', people: [],
        status: 'ready', chips_count: 1, chips_linked: 1, line_total: 52.5, due_at: null, is_test: true, phone_verified: false,
      }),
    ];
    const { pdf, pages, painted } = await pdfOf(pdfInput(CHIP_ORDERS_EXPORT, rows, ['סה״כ 2 שורות', 'סינון: „דנה”']), 'chip-orders');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages).toBe(1);

    // An embedded TrueType font program, named Heebo — and nothing on the page
    // is drawn with a font that is not in the file.
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('/BaseFont /Heebo');
    expect(painted.length).toBeGreaterThan(20);
    expect(painted.every((p) => p.text !== null)).toBe(true);
    const lines = painted.map((p) => p.text);

    // The title is the tab's; the date stands in its reading order.
    expect(lines).toContain(rev('הזמנות צ׳יפים'));
    expect(lines).toContain(`24/11/2026 12:00 ${rev('תאריך הפקה:')}`);
    // What the file holds, one line, right to left: the count first (right-most).
    expect(lines).toContain(`${rev('סינון: "דנה"')} · ${rev('שורות')} 2 ${rev('סה״כ')}`);

    // Hebrew is painted back to front…
    expect(lines).toContain(rev('דנה כהן'));
    expect(lines).toContain(rev('שם המזמין'));
    // …a phone, a foreign phone with its "+", a date, an amount and a number are not.
    for (const asIs of ['0539300001', '+447911123456', '23/11/2026', '26/11/2026 10:00', '1042', '52.5', '100', '7']) {
      expect(lines, asIs).toContain(asIs);
    }
    // A number inside a Hebrew line keeps its digits and its place in the sentence.
    expect(lines).toContain(`2 ${rev('מתוך')} 1 ${rev('שויכו')}`);
    // An English name inside the Hebrew table reads left to right.
    expect(lines).toContain('Yossi Mizrahi');
    // The tags in words; a cell with nothing to say is a dash.
    expect(lines).toContain(`${rev('טלפון לא אומת')} ,${rev('בדיקה')}`);
    expect(lines).toContain('—');

    // Right to left: the first column is the right-most, every next one further left.
    // (The header row = the lines on the baseline of one of its labels.)
    const headY = painted.find((p) => p.text === rev('שם המזמין'))!.y;
    const headRow = painted.filter((p) => Math.abs(p.y - headY) < 0.01);
    expect(headRow).toHaveLength(CHIP_ORDERS_EXPORT.columns.length);
    const headerX = CHIP_ORDERS_EXPORT.columns.map((c) => {
      const hit = headRow.find((p) => p.text === toVisual(c.header)); // "סה״כ (₪)": the sign and the brackets are not plain Hebrew
      expect(hit, c.header).toBeTruthy();
      return hit!.x;
    });
    expect([...headerX].sort((a, b) => b - a)).toEqual(headerX);

    // The page number, in words.
    expect(lines).toContain(`1 ${rev('מתוך')} 1 ${rev('עמוד')}`);
  });

  it('the chips tab: a chip number and an apartment read left to right; a name in another script is never lost', async () => {
    const rows = [
      chip({ id: 'a' }),
      chip({ id: 'b', chip_number: 'A1B2-C3', apartment_number: '505', holder_name: null, live_holder_name: String.fromCodePoint(0x418, 0x432, 0x430, 0x43d), resident_role: 'tenant' }),
    ];
    const { pages, painted } = await pdfOf(pdfInput(CHIPS_EXPORT, rows, ['סה״כ 2 שורות', 'סינון: פעילים']), 'chips');
    const lines = painted.map((p) => p.text);
    expect(pages).toBe(1);
    expect(lines).toContain(rev('צ׳יפים'));
    for (const asIs of ['0012345678', 'A1B2-C3', '505', '12', '24/11/2026']) expect(lines, asIs).toContain(asIs);
    expect(lines).toContain(rev('בעל דירה'));
    expect(lines).toContain(rev('שוכר'));
    expect(lines).toContain('????');
  });

  it('an apartment whose name holds Hebrew is a Hebrew line, though its column reads left to right', async () => {
    const rows = [chip({ id: 'a', apartment_number: 'מחסן 12' }), chip({ id: 'b', apartment_number: '7א' }), chip({ id: 'c', apartment_number: '-3' })];
    const { painted } = await pdfOf(pdfInput(CHIPS_EXPORT, rows, []), 'chips-apartments');
    const lines = painted.map((p) => p.text);
    // "מחסן 12": the word on the right, its number to the left of it.
    expect(lines).toContain(`12 ${rev('מחסן')}`);
    // "7א": the digit first for a right-to-left reader.
    expect(lines).toContain('א7');
    // No Hebrew = left to right: the sign stays in front of the digit.
    expect(lines).toContain('-3');
  });

  it('a long list: the header row and the page number on every page, and no row is lost', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => chip({ id: `c${i}`, chip_number: `77${String(i).padStart(4, '0')}` }));
    const { pages, painted } = await pdfOf(pdfInput(CHIPS_EXPORT, rows, ['סה״כ 120 שורות']), 'chips-long');
    expect(pages).toBeGreaterThan(2);
    for (let p = 1; p <= pages; p++) {
      const onPage = painted.filter((x) => x.page === p).map((x) => x.text);
      expect(onPage, `page ${p}`).toContain(rev('מחזיק'));
      expect(onPage, `page ${p}`).toContain(`${pages} ${rev('מתוך')} ${p} ${rev('עמוד')}`);
    }
    // The first page carries the title; every later one says what it belongs to.
    expect(painted.filter((x) => x.page === 1).map((x) => x.text)).toContain(rev('צ׳יפים'));
    expect(painted.filter((x) => x.page === 2).map((x) => x.text)).toContain(`24/11/2026 12:00 · ${rev('צ׳יפים')}`);
    const numbers = painted.map((x) => x.text).filter((t): t is string => t !== null && /^77\d{4}$/.test(t));
    expect(numbers).toEqual(rows.map((r) => r.chip_number));
  });

  it('a long name wraps on whole words inside its column, and reads on from line to line', async () => {
    const long = 'אלכסנדרה ולדימירובנה פטרובסקי מהקומה השלישית בבניין הצפוני של מתחם המגורים הגדול';
    const { painted } = await pdfOf(pdfInput(CHIP_ORDERS_EXPORT, [order({ full_name: long, people: ['דנה כהן'] })], []), 'chip-orders-long-name');
    // The lines of the orderer's cell: the ones made of the name's words only.
    const words = long.split(' ');
    const cell = painted.filter((p) => p.text !== null && p.text.split(' ').every((w) => words.includes(rev(w))));
    expect(cell.length, 'the name takes more than one line').toBeGreaterThan(1);
    // One column: every line ends at the same right edge… (x is where a line
    // starts, so a shorter line starts further right — the y is what orders them)
    const topDown = [...cell].sort((a, b) => b.y - a.y);
    // …and read top to bottom, each line right to left, the name is whole again.
    expect(topDown.map((p) => rev(p.text!)).join(' ')).toBe(long);
  });
});

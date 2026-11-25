import type { Buffer as ExcelBuffer } from 'exceljs';
import { sanitizeCell } from '@/lib/portal/ui';

// One column model for the three ways a list of /chips leaves the screen —
// "הדפסה", "ייצוא לאקסל" and "הורדה ל-PDF" (25/11/2026; both tabs). A list
// describes its columns once and the three outputs read the same description,
// so a column added to one of them cannot be forgotten in another.
// Pure and client-safe apart from downloadFile(): everything is built in the
// browser from the rows the tab already holds — nothing is fetched.

export interface ExportColumn<T> {
  header: string;
  /** number / money — numeric cells Excel can sum; ltr — a phone, a date or a
   *  chip number: kept as text, and isolated left-to-right in print. */
  kind: 'text' | 'number' | 'money' | 'ltr';
  /** Excel column width (characters). The print view and the PDF file size
   *  their columns from what the cells hold. */
  width: number;
  get: (row: T, now: Date) => string | number;
}

/** What one list exports as: its columns and its names. */
export interface ListExport<T> {
  /** The heading of the print view and of the PDF file. */
  title: string;
  /** The name of the Excel sheet. */
  sheet: string;
  /** The file name before the date: `<file>_YYYY-MM-DD.xlsx` / `.pdf`. */
  file: string;
  columns: ExportColumn<T>[];
}

export const EXPORT_MONEY_FMT = '#,##0.00';

const MONEY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A cell as the print view and the PDF file write it. The unit of a money
 *  column is in its header ("סה״כ (₪)"), as in the Excel file. */
export function exportCellText<T>(column: ExportColumn<T>, row: T, now: Date): string {
  const v = column.get(row, now);
  return column.kind === 'money' ? MONEY.format(Number(v)) : String(v);
}

// ── Dates (Israel time, whatever the browser's own zone is) ────────────────

const IL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** null for a value that is no date — a cell then stays empty, and a file is
 *  never lost to one bad value. */
function ilParts(at: string | Date): Record<string, string> | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return Object.fromEntries(IL.formatToParts(d).map((p) => [p.type, p.value]));
}

/** dd/mm/yyyy in Israel time. */
export function exportDate(at: string | Date): string {
  const p = ilParts(at);
  return p ? `${p.day}/${p.month}/${p.year}` : '';
}

/** dd/mm/yyyy hh:mm in Israel time. */
export function exportDateTime(at: string | Date): string {
  const p = ilParts(at);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '';
}

// ── Excel (ExcelJS — the debtors and the portal exports' pattern) ──────────

/** The workbook bytes — pure (no DOM), so a test can build the real file and
 *  read it back. One line per row, right-to-left sheet, numbers as numbers. */
export async function buildListWorkbook<T>(list: ListExport<T>, rows: T[], now: Date = new Date()): Promise<ExcelBuffer> {
  // A dynamic import keeps ExcelJS out of the main bundle.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  // rightToLeft so the Hebrew sheet opens with its first column on the right.
  const ws = wb.addWorksheet(list.sheet, { views: [{ rightToLeft: true }] });
  ws.columns = list.columns.map((c) => ({
    header: c.header,
    width: c.width,
    ...(c.kind === 'money' ? { style: { numFmt: EXPORT_MONEY_FMT } } : {}),
  }));
  for (const r of rows) {
    ws.addRow(
      list.columns.map((c) => {
        const v = c.get(r, now);
        if (c.kind === 'number' || c.kind === 'money') return Number(v);
        // Nothing to show (no due date, no tag) → a truly blank cell, not ''.
        if (v === '') return null;
        // A name may come from the public order page: a text that starts like
        // a formula must open as text (formula injection).
        return sanitizeCell(String(v));
      }),
    );
  }
  return wb.xlsx.writeBuffer();
}

// ── The file itself ────────────────────────────────────────────────────────

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';

/** `<base>_YYYY-MM-DD.<ext>`, by the browser's own date (as the debtors export). */
export function exportFileName(base: string, ext: 'xlsx' | 'pdf', at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}_${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.${ext}`;
}

/** Hands the bytes to the browser as a download. */
export function downloadFile(data: BlobPart, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

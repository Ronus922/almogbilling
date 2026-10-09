'use client';

import type { Buffer as ExcelBuffer } from 'exceljs';
import type { Debtor } from '@/lib/db/debtors';
import { formatPhoneDisplay, getPrimaryPhone } from '@/lib/phone';
import { unpaidMonthsByType } from './unpaid-months';

// Shared column model for the debtors export/print (Excel / PDF / print view).
// The base entries are the section-6 headers, WITHOUT the "פעולות" column; the
// two "months" entries exist in the Excel file only.

export interface ExportColumn {
  header: string;
  kind: 'text' | 'number' | 'phone';
  /** Excel column width (characters). PDF / print ignore it. */
  width: number;
  get: (d: Debtor) => string | number;
}

const COL = {
  apartment:  { header: 'מס׳ דירה',     kind: 'text',   width: 10, get: (d) => d.apartment_number },
  owner:      { header: 'שם בעל הדירה', kind: 'text',   width: 24, get: (d) => d.owner_name ?? '' },
  phone:      { header: 'טלפון',        kind: 'phone',  width: 16, get: (d) => formatPhoneDisplay(getPrimaryPhone(d)) ?? '' },
  total:      { header: 'סה״כ חוב',     kind: 'number', width: 12, get: (d) => d.total_debt },
  management: { header: 'דמי ניהול',    kind: 'number', width: 12, get: (d) => d.management_fees },
  hotWater:   { header: 'מים חמים',     kind: 'number', width: 12, get: (d) => d.hot_water_debt },
  status:     { header: 'מצב משפטי',    kind: 'text',   width: 16, get: (d) => d.legal_status_name ?? '—' },
  // Excel only (08/10/2026): the months behind the two money columns, derived
  // from the row's Bllink texts (lib/export/unpaid-months.ts). Text, never a
  // number/date — "01-02/26" must survive Excel as it is.
  monthsManagement: {
    header: 'חודשים שלא שולמו — דמי ניהול', kind: 'text', width: 28,
    get: (d) => unpaidMonthsByType(d).managementFees,
  },
  monthsHotWater: {
    header: 'חודשים שלא שולמו — מים חמים', kind: 'text', width: 40,
    get: (d) => unpaidMonthsByType(d).hotWater,
  },
} satisfies Record<string, ExportColumn>;

/** PDF + print view: the section-6 table as it always was. */
export const DEBTOR_EXPORT_COLUMNS: ExportColumn[] = [
  COL.apartment, COL.owner, COL.phone, COL.total, COL.management, COL.hotWater, COL.status,
];

/** Excel: the same columns, each money column followed by its unpaid months. */
export const DEBTOR_EXCEL_COLUMNS: ExportColumn[] = [
  COL.apartment, COL.owner, COL.phone, COL.total,
  COL.management, COL.monthsManagement,
  COL.hotWater, COL.monthsHotWater,
  COL.status,
];

/** The two Excel-only columns: declared text ('@') so Excel never reads
 *  "01-02/26" as a date, and a truly BLANK cell (not '') when there is nothing.
 *  The pre-existing columns are written exactly as before. */
const MONTHS_COLUMNS = new Set<ExportColumn>([COL.monthsManagement, COL.monthsHotWater]);

const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

function fileName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `debtors_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${ext}`;
}

export function todayHe(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ── Excel (ExcelJS — replaced SheetJS/xlsx, closing its unpatched CVEs) ──────

/** The workbook bytes of the Excel export — pure (no DOM), so a test can build
 *  the real file and read it back. */
export async function buildDebtorsWorkbook(rows: Debtor[]): Promise<ExcelBuffer> {
  // Dynamic import keeps ExcelJS out of the main bundle (as the old xlsx import did).
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  // rightToLeft so the Hebrew sheet opens with "מס׳ דירה" on the right.
  const ws = wb.addWorksheet('חייבים', { views: [{ rightToLeft: true }] });
  // Header row + column ORDER + widths preserved; number columns stay numeric so
  // Excel can SUM the money columns; phone/text stay strings.
  ws.columns = DEBTOR_EXCEL_COLUMNS.map((c) => ({
    header: c.header,
    width: c.width,
    ...(MONTHS_COLUMNS.has(c) ? { style: { numFmt: '@' } } : {}),
  }));
  for (const d of rows) {
    ws.addRow(
      DEBTOR_EXCEL_COLUMNS.map((c) => {
        const v = c.get(d);
        if (c.kind === 'number') return Number(v);
        if (MONTHS_COLUMNS.has(c) && v === '') return null;
        return String(v);
      }),
    );
  }
  return wb.xlsx.writeBuffer();
}

export async function exportDebtorsExcel(rows: Debtor[]): Promise<void> {
  const buf = await buildDebtorsWorkbook(rows);
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName('xlsx');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── PDF (jsPDF + autotable + embedded Heebo) ─────────────────────────────────
// jsPDF places glyphs left-to-right with no bidi, so a Hebrew string would read
// mirrored. Reverse strings that contain Hebrew (verified visually: title,
// headers, names + statuses all render correctly); leave pure digits/Latin
// (apartment, phone, amounts, the date) as-is.
const HEBREW = /[֐-׿]/;
function rtl(s: string): string {
  return HEBREW.test(s) ? s.split('').reverse().join('') : s;
}

export async function exportDebtorsPdf(rows: Debtor[]): Promise<void> {
  const [{ jsPDF }, autoTableMod, { registerHeebo }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('@/lib/pdf-heebo'),
  ]);
  const autoTable = (autoTableMod as unknown as { default: typeof import('jspdf-autotable').default }).default;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  registerHeebo(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  doc.setFontSize(16);
  doc.setTextColor(26, 34, 51);
  doc.text(rtl('טבלת חייבים'), pageW - margin, 16, { align: 'right' });

  doc.setFontSize(10);
  doc.setTextColor(120, 130, 145);
  doc.text(rtl(`סה״כ ${rows.length} רשומות`), pageW - margin, 23, { align: 'right' });
  // Date in its own call (pure LTR) so it isn't reversed by the mixed-run heuristic.
  doc.text(todayHe(), margin, 23, { align: 'left' });
  doc.setTextColor(0, 0, 0);

  // RTL column order: reverse the array so "מס׳ דירה" sits on the right.
  const cols = [...DEBTOR_EXPORT_COLUMNS].reverse();
  const head = [cols.map((c) => rtl(c.header))];
  const body = rows.map((d) =>
    cols.map((c) => {
      const v = c.get(d);
      return c.kind === 'number' ? numFmt.format(Number(v)) : rtl(String(v));
    }),
  );

  autoTable(doc, {
    head,
    body,
    startY: 28,
    styles: { font: 'Heebo', fontStyle: 'normal', halign: 'right', fontSize: 9, cellPadding: 1.8, textColor: [26, 34, 51] },
    headStyles: { font: 'Heebo', fontStyle: 'bold', fillColor: [241, 245, 249], textColor: [51, 65, 85], halign: 'right' },
    alternateRowStyles: { fillColor: [250, 251, 254] },
    margin: { left: margin, right: margin },
  });

  doc.save(fileName('pdf'));
}

'use client';

import type { Debtor } from '@/lib/db/debtors';
import { formatPhoneDisplay, getPrimaryPhone } from '@/lib/phone';

// Shared column model for the debtors export/print (Excel / PDF / print view).
// Order + labels are the section-6 headers, WITHOUT the "פעולות" column.

export interface ExportColumn {
  header: string;
  kind: 'text' | 'number' | 'phone';
  get: (d: Debtor) => string | number;
}

export const DEBTOR_EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'מס׳ דירה', kind: 'text', get: (d) => d.apartment_number },
  { header: 'שם בעל הדירה', kind: 'text', get: (d) => d.owner_name ?? '' },
  { header: 'טלפון', kind: 'phone', get: (d) => formatPhoneDisplay(getPrimaryPhone(d)) ?? '' },
  { header: 'סה״כ חוב', kind: 'number', get: (d) => d.total_debt },
  { header: 'דמי ניהול', kind: 'number', get: (d) => d.management_fees },
  { header: 'מים חמים', kind: 'number', get: (d) => d.hot_water_debt },
  { header: 'מצב משפטי', kind: 'text', get: (d) => d.legal_status_name ?? '—' },
];

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
const EXPORT_COL_WIDTHS = [10, 24, 16, 12, 12, 12, 16];

export async function exportDebtorsExcel(rows: Debtor[]): Promise<void> {
  // Dynamic import keeps ExcelJS out of the main bundle (as the old xlsx import did).
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  // rightToLeft so the Hebrew sheet opens with "מס׳ דירה" on the right.
  const ws = wb.addWorksheet('חייבים', { views: [{ rightToLeft: true }] });
  // Header row + column ORDER + widths preserved; number columns stay numeric so
  // Excel can SUM the money columns; phone/text stay strings.
  ws.columns = DEBTOR_EXPORT_COLUMNS.map((c, i) => ({
    header: c.header,
    width: EXPORT_COL_WIDTHS[i],
  }));
  for (const d of rows) {
    ws.addRow(
      DEBTOR_EXPORT_COLUMNS.map((c) => {
        const v = c.get(d);
        return c.kind === 'number' ? Number(v) : String(v);
      }),
    );
  }
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf as ArrayBuffer], {
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

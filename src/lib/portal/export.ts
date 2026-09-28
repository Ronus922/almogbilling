'use client';

import type { ResidentEntry } from '@/lib/types/finance';
import { fmtEntryDate, monthTitle, sanitizeCell, type TxFilter } from '@/lib/portal/ui';

// "ייצוא לאקסל" of the transactions tab: exactly the rows on screen (the
// chosen month, the chosen filter), which portal.ts already restricted to
// published months — nothing is fetched here. Same ExcelJS pattern as the
// debtors export (dynamic import keeps it out of the main bundle), same
// resident columns as the table: no supplier, no invoice, no note. The
// screen shows whole shekels; the file keeps the exact amount with its
// agorot, as a number with two decimals (decision 28/09/2026) — nothing is
// lost by exporting.

const COLUMNS = [
  { header: 'תיאור', width: 40 },
  { header: 'קטגוריה', width: 28 },
  { header: 'סוג', width: 10 },
  { header: 'תאריך', width: 12 },
  { header: 'סכום', width: 14 },
] as const;

const AMOUNT_COL = 5;
export const AMOUNT_NUM_FMT = '#,##0.00';

/** The workbook of one month's rows — built apart from the download so a
 *  test can open it. */
export async function buildPortalMonthWorkbook(args: { monthKey: string; rows: readonly ResidentEntry[] }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(monthTitle(args.monthKey), { views: [{ rightToLeft: true }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  for (const e of args.rows) {
    // Text cells go through sanitizeCell: a description typed as "=…" or
    // "@…" must open as text, never as a formula (formula injection).
    const row = ws.addRow([
      sanitizeCell(e.description || e.category_name),
      sanitizeCell(e.category_name),
      e.kind === 'income' ? 'הכנסה' : 'הוצאה',
      fmtEntryDate(e),
      Number(e.amount),
    ]);
    row.getCell(AMOUNT_COL).numFmt = AMOUNT_NUM_FMT;
  }
  return wb;
}

export async function exportPortalMonthExcel(args: { monthKey: string; filter: TxFilter; rows: readonly ResidentEntry[] }): Promise<void> {
  const wb = await buildPortalMonthWorkbook(args);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `almog-portal-${args.monthKey}${args.filter === 'all' ? '' : `-${args.filter}`}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

'use client';

import type { ResidentEntry } from '@/lib/types/finance';
import { periodLabel, type Period } from '@/lib/finance/period';
import { fmtEntryDate, sanitizeCell, type TxFilter } from '@/lib/portal/ui';

// "ייצוא לאקסל" of the transactions tab: exactly the rows on screen (the
// chosen period — a month, a quarter, a half or a year — and the chosen
// filter), which portal.ts already restricted to published months — a quarter
// that holds a hidden month exports the published ones alone, and nothing is
// fetched here. Same ExcelJS pattern as the debtors export (dynamic import
// keeps it out of the main bundle), same resident columns as the table: no
// supplier, no invoice, no note. The
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

/** The workbook of the period's rows — built apart from the download so a
 *  test can open it. */
export async function buildPortalPeriodWorkbook(args: { period: Period; rows: readonly ResidentEntry[] }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(periodLabel(args.period), { views: [{ rightToLeft: true }] });
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

export async function exportPortalPeriodExcel(args: { period: Period; filter: TxFilter; rows: readonly ResidentEntry[] }): Promise<void> {
  const wb = await buildPortalPeriodWorkbook(args);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `almog-portal-${args.period.key}${args.filter === 'all' ? '' : `-${args.filter}`}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

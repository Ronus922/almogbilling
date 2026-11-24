'use client';

import type { Buffer as ExcelBuffer } from 'exceljs';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import { CHIP_ORDER_EXPORT_COLUMNS } from '@/lib/chipOrders/orderRows';
import { sanitizeCell } from '@/lib/portal/ui';

// "ייצוא לאקסל" of /chips → "הזמנות" (24/11/2026): exactly the rows on the
// screen — after the search and the test-orders switch — one line per row, in
// the columns of CHIP_ORDER_EXPORT_COLUMNS (shared with the print view).
// Nothing is fetched: the tab already holds the rows. Same ExcelJS pattern as
// the debtors and the portal exports (a dynamic import keeps ExcelJS out of
// the main bundle).

export const CHIP_ORDER_MONEY_FMT = '#,##0.00';

/** The workbook bytes — pure (no DOM), so a test can build the real file and
 *  read it back. `now` decides "באיחור". */
export async function buildChipOrdersWorkbook(rows: ChipOrderRow[], now: Date = new Date()): Promise<ExcelBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  // rightToLeft so the Hebrew sheet opens with "מס׳ הזמנה" on the right.
  const ws = wb.addWorksheet('הזמנות צ׳יפים', { views: [{ rightToLeft: true }] });
  ws.columns = CHIP_ORDER_EXPORT_COLUMNS.map((c) => ({
    header: c.header,
    width: c.width,
    ...(c.kind === 'money' ? { style: { numFmt: CHIP_ORDER_MONEY_FMT } } : {}),
  }));
  for (const r of rows) {
    ws.addRow(
      CHIP_ORDER_EXPORT_COLUMNS.map((c) => {
        const v = c.get(r, now);
        if (c.kind === 'number' || c.kind === 'money') return Number(v);
        // Nothing to show (no due date) → a truly blank cell, not ''.
        if (v === '') return null;
        // Names come from the public order page: a text that starts like a
        // formula must open as text (formula injection) — as the portal export.
        return sanitizeCell(String(v));
      }),
    );
  }
  return wb.xlsx.writeBuffer();
}

function fileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `chip-orders_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`;
}

export async function exportChipOrdersExcel(rows: ChipOrderRow[]): Promise<void> {
  const buf = await buildChipOrdersWorkbook(rows);
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

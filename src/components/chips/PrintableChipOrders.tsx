'use client';

import { createPortal } from 'react-dom';
import type { ChipOrderRow } from '@/lib/chipOrders/model';
import { CHIP_ORDER_EXPORT_COLUMNS, formatOrderDate } from '@/lib/chipOrders/orderRows';

const MONEY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * The print-only view of /chips → "הזמנות" (24/11/2026): the rows on the screen
 * — after the search and the test-orders switch — in the columns of the Excel
 * file, right to left, with no menu and no buttons. Rendered into a portal on
 * document.body (id="chip-orders-print-root"); hidden on the screen and shown
 * only by the @media print rules of app/styles/print.css, which hide every
 * other child of <body>. The same mechanism as the debtors table's print view.
 */
export function PrintableChipOrders({ rows, query }: { rows: ChipOrderRow[]; query: string }) {
  // Mounted only by a click on "הדפסה" — always in the browser, after hydration.
  if (typeof document === 'undefined') return null;
  const now = new Date();

  return createPortal(
    <div id="chip-orders-print-root" dir="rtl" data-testid="chip-orders-print">
      <div className="app-print-head">
        <h1>הזמנות צ׳יפים פתוחות</h1>
        <div className="app-print-meta">
          <span>סה״כ {rows.length} שורות</span>
          {query.trim() && <span>סינון: „{query.trim()}”</span>}
          <span>תאריך הפקה: {formatOrderDate(now.toISOString())}</span>
        </div>
      </div>
      <table className="app-print-table">
        <thead>
          <tr>
            {CHIP_ORDER_EXPORT_COLUMNS.map((c) => (
              <th key={c.header}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.item_id}>
              {CHIP_ORDER_EXPORT_COLUMNS.map((c) => {
                const v = c.get(r, now);
                // The unit is in the column's header ("סה״כ (₪)"), as in the Excel file.
                if (c.kind === 'money') return <td key={c.header} className="num" dir="ltr">{MONEY.format(Number(v))}</td>;
                if (c.kind === 'number') return <td key={c.header} className="num" dir="ltr">{v}</td>;
                return <td key={c.header} className={c.kind === 'ltr' ? 'ltr' : undefined}>{String(v) || '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

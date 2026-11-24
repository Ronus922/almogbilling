'use client';

import { createPortal } from 'react-dom';
import { exportCellText, type ListExport } from '@/lib/export/list-export';

/**
 * The print-only view of a list of /chips — "הדפסה" of both tabs (25/11/2026):
 * the rows the tab shows right now, in the columns of its Excel file, right
 * to left, with no menu and no buttons. Rendered into a portal on
 * document.body (id="chips-print-root"); hidden on the screen and shown only
 * by the @media print rules of app/styles/print.css, which hide every other
 * child of <body>. The same mechanism as the debtors table's print view.
 */
export function PrintableChipList<T>({
  list, rows, rowKey, meta, date,
}: {
  list: ListExport<T>;
  rows: T[];
  rowKey: (row: T) => string;
  /** What the page holds: the number of rows, the filter in force. */
  meta: string[];
  /** When it was printed, as text. */
  date: string;
}) {
  // Mounted only by a click on "הדפסה" — always in the browser, after hydration.
  if (typeof document === 'undefined') return null;
  const now = new Date();

  return createPortal(
    <div id="chips-print-root" dir="rtl">
      <div className="app-print-head">
        <h1>{list.title}</h1>
        <div className="app-print-meta">
          {meta.map((m) => <span key={m}>{m}</span>)}
          {/* The date and its time read left to right, as one piece. */}
          <span>תאריך הפקה: <bdi dir="ltr">{date}</bdi></span>
        </div>
      </div>
      <table className="app-print-table">
        <thead>
          <tr>
            {list.columns.map((c) => (
              <th key={c.header}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {list.columns.map((c) => {
                const text = exportCellText(c, r, now) || '—';
                // A number, a phone, a date: left to right, so a sign or a
                // slash never jumps to the other side of the digits.
                if (c.kind === 'number' || c.kind === 'money') return <td key={c.header} className="num" dir="ltr">{text}</td>;
                // <bdi> reads its own text: digits and Latin stay left to
                // right, and a value that does hold Hebrew (an apartment
                // called "מחסן 12") reads right to left.
                if (c.kind === 'ltr') return <td key={c.header} className="ltr"><bdi>{text}</bdi></td>;
                return <td key={c.header}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

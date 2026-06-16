'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Debtor } from '@/lib/db/debtors';
import { DEBTOR_EXPORT_COLUMNS, todayHe } from '@/lib/export/debtors-export';

const numFmt = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

/**
 * Clean print-only rendering of the current filtered debtor set. Rendered into a
 * portal on document.body (id="debtors-print-root"); hidden on screen and shown
 * only by the @media print rules in app/styles/print.css, which hide all other
 * app chrome (sidebar / header / toolbar / pagination).
 */
export function PrintableDebtorsTable({ rows }: { rows: Debtor[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div id="debtors-print-root" dir="rtl">
      <div className="debtors-print-head">
        <h1>טבלת חייבים</h1>
        <div className="debtors-print-meta">
          <span>סה״כ {rows.length} רשומות</span>
          <span>תאריך הפקה: {todayHe()}</span>
        </div>
      </div>
      <table className="debtors-print-table">
        <thead>
          <tr>
            {DEBTOR_EXPORT_COLUMNS.map((c) => (
              <th key={c.header}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              {DEBTOR_EXPORT_COLUMNS.map((c) => {
                const v = c.get(d);
                if (c.kind === 'number') {
                  return (
                    <td key={c.header} className="num" dir="ltr">
                      ₪ {numFmt.format(Number(v))}
                    </td>
                  );
                }
                return (
                  <td key={c.header} className={c.kind === 'phone' ? 'ltr' : undefined}>
                    {String(v) || '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

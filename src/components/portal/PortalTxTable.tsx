import type { ResidentEntry } from '@/lib/types/finance';
import { fmtEntryDate, fmtIls } from '@/lib/portal/ui';
import { DocIcon } from './PortalIcons';

// The reference's five-column transactions table (description · category ·
// date · amount · document) inside a `.tw` scroller — list rows under 600px
// by CSS alone (portal.css). What a resident row shows and what it does not:
//   • the amount in whole shekels, green-ink for an income (.in) and red-ink
//     for an expense (.out) — the sign stays (decision 28/09/2026);
//   • .ds = the description (the category when the line has none);
//   • no .sb line — the reference puts the counterparty there, and a supplier
//     name never reaches the portal (Phase 0, 28/09/2026);
//   • the document button only when the line carries receipts, which
//     portal.ts attaches only while "הצג מסמכים לדיירים" is on. The link is
//     the authenticated /api/files proxy, so the view is audited (F9).
export function PortalTxTable({ rows, emptyText }: { rows: readonly ResidentEntry[]; emptyText: string }) {
  if (rows.length === 0) {
    return <p className="note" style={{ marginTop: 14 }}>{emptyText}</p>;
  }
  return (
    <div className="tw">
      <table>
        <thead>
          <tr><th>תיאור</th><th>קטגוריה</th><th>תאריך</th><th>סכום</th><th>מסמך</th></tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const income = e.kind === 'income';
            return (
              <tr key={`${e.period_month}-${e.category_name}-${i}`}>
                <td><div className="ds">{e.description || e.category_name}</div></td>
                <td><span className={`tag ${income ? 't-green' : 't-gray'}`}>{e.category_name}</span></td>
                <td className="num" style={{ color: 'var(--ink-muted)' }}>{fmtEntryDate(e)}</td>
                <td><span className={`amt num ${income ? 'in' : 'out'}`}>{income ? '+' : '−'}{fmtIls(e.amount)}</span></td>
                <td>
                  {e.documents?.map((d, k) => (
                    <a key={k} className="doc" href={d.url} target="_blank" rel="noopener" title={d.name} aria-label={`פתיחת מסמך: ${d.name}`}>
                      <DocIcon />
                    </a>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

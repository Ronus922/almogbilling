'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { FinKind } from '@/lib/constants/finance';
import type { ResidentMonthData } from '@/lib/types/finance';
import { exportPortalMonthExcel } from '@/lib/portal/export';
import {
  catColor, categoriesOf, flatEntries, fmtIls, fmtSigned, monthName, monthTitle, monthsByYear, signClass, type TxFilter,
} from '@/lib/portal/ui';
import { PortalTxTable } from './PortalTxTable';
import { ArrowDownIcon, ArrowUpIcon, ExportIcon, ScaleIcon, WalletIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The transactions tab (#t-tx of the reference) for one published month:
// the month select (the old picker's rule, unchanged — only published months,
// grouped by year, newest first, the newest one by default) and the Excel
// export in the header; the month's three KPIs; the all / income / expense
// chips over the five-column table; and the month's lines per category.
// The month is a navigation (`?m=`, server data); the chip filter is a local
// state mirrored into `?f=` so a refresh keeps it. Every amount is shown in
// whole shekels (fmtIls); the KPIs come from the server's exact totals; an
// income is green-ink, an expense red-ink, the difference by its sign, the
// bank balance neutral (decision 28/09/2026).

const FILTERS: ReadonlyArray<{ key: TxFilter; label: string }> = [
  { key: 'all', label: 'הכל' },
  { key: 'in', label: 'הכנסות' },
  { key: 'out', label: 'הוצאות' },
];

function Cats({ title, kind, items }: { title: string; kind: FinKind; items: ReturnType<typeof categoriesOf> }) {
  const tone = kind === 'income' ? 'in' : 'out';
  return (
    <div className="card c6">
      <h3>{title}</h3>
      <div className="cats">
        {items.length === 0 && <p className="note">אין תנועות.</p>}
        {items.map((c, i) => (
          <div className="cat" key={c.name}>
            <span className="n"><i style={{ background: catColor(i) }} /><em title={c.name}>{c.name}</em></span>
            <span className={`a num ${tone}`}>{fmtIls(c.total)}<small>{c.pct}%</small></span>
            <div className="bar"><b style={{ width: `${c.bar}%`, background: catColor(i) }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PortalTransactions({ monthKey, publishedMonths, data, filter: initialFilter }: {
  monthKey: string;
  /** 'YYYY-MM', newest first. */
  publishedMonths: string[];
  /** null = the month is not published (cannot happen for a key from the select). */
  data: ResidentMonthData | null;
  filter: TxFilter;
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<TxFilter>(initialFilter);
  const [exporting, setExporting] = useState(false);

  function changeMonth(key: string) {
    if (key === monthKey) return;
    startTransition(() => router.push(href({ tab: 'tx', m: key, f: filter === 'all' ? null : filter })));
  }

  function changeFilter(next: TxFilter) {
    setFilter(next);
    window.history.replaceState(window.history.state, '', href({ tab: 'tx', m: monthKey, f: next === 'all' ? null : next }));
  }

  const op = data?.operating ?? null;
  const all = op ? [...op.income, ...op.expense] : [];
  const rows = flatEntries(all, filter);
  const showsDocs = all.some((e) => (e.documents?.length ?? 0) > 0);

  async function exportExcel() {
    if (exporting || rows.length === 0) return;
    setExporting(true);
    try {
      await exportPortalMonthExcel({ monthKey, filter, rows });
    } catch {
      toast.error('הייצוא נכשל');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section id="t-tx">
      <div className="hd">
        <div>
          <h1>הכנסות והוצאות</h1>
          <p>כל תנועה בקופת הבניין{showsDocs ? ', כולל חשבוניות וקבלות' : ''} — {monthTitle(monthKey)}</p>
        </div>
        <div className="per" style={pending ? { opacity: 0.7 } : undefined}>
          <select className="sel" aria-label="חודש" value={monthKey} onChange={(e) => changeMonth(e.target.value)}>
            {monthsByYear(publishedMonths).map((y) => (
              <optgroup key={y.year} label={y.year}>
                {y.months.map((k) => <option key={k} value={k}>{monthName(k)} {y.year}</option>)}
              </optgroup>
            ))}
          </select>
          <button type="button" className="pbtn pbtn-secondary" onClick={exportExcel} disabled={exporting || rows.length === 0}>
            <ExportIcon />ייצוא לאקסל
          </button>
        </div>
      </div>

      {!op ? (
        <div className="card empty"><h2>החודש הזה לא פורסם.</h2></div>
      ) : (
        <div className="pgrid">
          <div className="kpis c12" data-count={data?.bank_balance !== undefined ? 4 : 3}>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><ArrowUpIcon /></span>
              <div className="k">הכנסות</div>
              <div className="v num in">{fmtIls(op.totals.income)}</div>
              <div className="d">תקציב שוטף</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><ArrowDownIcon /></span>
              <div className="k">הוצאות</div>
              <div className="v num out">{fmtIls(op.totals.expense)}</div>
              <div className="d">תקציב שוטף</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: op.totals.diff < 0 ? 'var(--amber-soft)' : 'var(--brand-soft)', color: op.totals.diff < 0 ? 'var(--amber)' : 'var(--brand)' }}><ScaleIcon /></span>
              <div className="k">הפרש</div>
              <div className={`v num ${signClass(op.totals.diff)}`}>{fmtSigned(op.totals.diff)}</div>
              <div className="d">{op.totals.diff < 0 ? <span className="dn">גירעון בחודש</span> : <span className="up">עודף בחודש</span>}</div>
            </div>
            {data?.bank_balance !== undefined && (
              <div className="card kpi">
                <span className="kpi-ic" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><WalletIcon /></span>
                <div className="k">יתרת בנק לסוף החודש</div>
                <div className="v num">{fmtSigned(data.bank_balance)}</div>
                <div className="d">{monthTitle(monthKey)}</div>
              </div>
            )}
          </div>

          <div className="card c12">
            <div className="chips" role="group" aria-label="סינון">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className={`chipf${filter === f.key ? ' on' : ''}`} aria-pressed={filter === f.key} onClick={() => changeFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <PortalTxTable rows={rows} emptyText={filter === 'in' ? `אין הכנסות ב${monthTitle(monthKey)}.` : filter === 'out' ? `אין הוצאות ב${monthTitle(monthKey)}.` : `אין תנועות ב${monthTitle(monthKey)}.`} />
          </div>

          {filter !== 'out' && <Cats title="הכנסות לפי קטגוריה" kind="income" items={categoriesOf(op.income, 'income')} />}
          {filter !== 'in' && <Cats title="הוצאות לפי קטגוריה" kind="expense" items={categoriesOf(op.expense, 'expense')} />}
        </div>
      )}
    </section>
  );
}

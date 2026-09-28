'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ResidentMonthData } from '@/lib/types/finance';
import { exportPortalMonthExcel } from '@/lib/portal/export';
import {
  catColor, categoriesOf, flatEntries, fmtIls, monthName, monthTitle, monthsByYear, type TxFilter,
} from '@/lib/portal/ui';
import { PortalTxTable } from './PortalTxTable';
import { ArrowDownIcon, ArrowUpIcon, ExportIcon, ScaleIcon } from './PortalIcons';

// The transactions tab (#t-tx of the reference) for one published month:
// the month select (the old picker's rule, unchanged — only published months,
// grouped by year, newest first, the newest one by default) and the Excel
// export in the header; the month's three KPIs; the all / income / expense
// chips over the five-column table; and the month's lines per category.
// The month is a navigation (`?m=`, server data); the chip filter is a local
// state mirrored into `?f=` so a refresh keeps it.

const FILTERS: ReadonlyArray<{ key: TxFilter; label: string }> = [
  { key: 'all', label: 'הכל' },
  { key: 'in', label: 'הכנסות' },
  { key: 'out', label: 'הוצאות' },
];

function Cats({ title, items }: { title: string; items: ReturnType<typeof categoriesOf> }) {
  return (
    <div className="card c6">
      <h3>{title}</h3>
      <div className="cats">
        {items.length === 0 && <p className="note">אין תנועות.</p>}
        {items.map((c, i) => (
          <div className="cat" key={c.name}>
            <span className="n"><i style={{ background: catColor(i) }} /><em title={c.name}>{c.name}</em></span>
            <span className="a num">{fmtIls(c.total)}<small>{c.pct}%</small></span>
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
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<TxFilter>(initialFilter);
  const [exporting, setExporting] = useState(false);

  function changeMonth(key: string) {
    if (key === monthKey) return;
    startTransition(() => router.push(`/portal?tab=tx&m=${key}${filter === 'all' ? '' : `&f=${filter}`}`));
  }

  function changeFilter(next: TxFilter) {
    setFilter(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'tx');
    url.searchParams.set('m', monthKey);
    if (next === 'all') url.searchParams.delete('f'); else url.searchParams.set('f', next);
    window.history.replaceState(window.history.state, '', url);
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
          <div className="kpis c12" data-count={3}>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><ArrowUpIcon /></span>
              <div className="k">הכנסות</div>
              <div className="v num">{fmtIls(op.totals.income)}</div>
              <div className="d">תקציב שוטף</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><ArrowDownIcon /></span>
              <div className="k">הוצאות</div>
              <div className="v num">{fmtIls(op.totals.expense)}</div>
              <div className="d">תקציב שוטף</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: op.totals.diff < 0 ? 'var(--amber-soft)' : 'var(--brand-soft)', color: op.totals.diff < 0 ? 'var(--amber)' : 'var(--brand)' }}><ScaleIcon /></span>
              <div className="k">הפרש</div>
              <div className="v num">{op.totals.diff < 0 ? '−' : ''}{fmtIls(op.totals.diff)}</div>
              <div className="d">{op.totals.diff < 0 ? <span className="dn">גירעון בחודש</span> : <span className="up">עודף בחודש</span>}</div>
            </div>
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

          {filter !== 'out' && <Cats title="הכנסות לפי קטגוריה" items={categoriesOf(op.income, 'income')} />}
          {filter !== 'in' && <Cats title="הוצאות לפי קטגוריה" items={categoriesOf(op.expense, 'expense')} />}
        </div>
      )}
    </section>
  );
}

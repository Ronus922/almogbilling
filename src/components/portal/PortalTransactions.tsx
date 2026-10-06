'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { FinKind } from '@/lib/constants/finance';
import { PeriodPicker } from '@/components/finance/PeriodPicker';
import { periodLabel, type Period } from '@/lib/finance/period';
import type { ResidentPeriodData } from '@/lib/types/finance';
import { exportPortalPeriodExcel } from '@/lib/portal/export';
import {
  catColor, categoriesOf, flatEntries, fmtIls, fmtSigned, monthShort, monthTitle, signClass,
  type TxFilter,
} from '@/lib/portal/ui';
import { PortalBarChart, type ChartPoint } from './PortalBarChart';
import { PortalCategoryTrend } from './PortalCategoryTrend';
import { PortalTxTable } from './PortalTxTable';
import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, ExportIcon, InfoIcon, ScaleIcon, WalletIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The transactions tab (#t-tx of the reference) for the selected period — one
// month, a quarter, a half or a whole year, and EVERY figure on the tab
// follows it (the KPIs, the income-vs-expenses chart, the categories, the rows
// and the closing bank balance). Only published months are in the picker and
// in the figures — the server puts that rule in the SQL
// (getResidentPeriodData), so nothing here has to hide anything.
//
// The picker is the ONE-CLICK grid of /finance (components/finance/PeriodPicker
// in `portal` dress), restored here on 29/09/2026: PR #44 (b51b791) deleted it
// with PortalFinanceView, and PR #49 brought back only a flat `<select>`. The
// grid is the decision of 27/09/2026 ("תאריכון בלחיצה אחת") and a permanent
// capability — « כל YYYY » with year arrows, a 3×4 month grid whose rows are
// quarters and row-pairs halves, every click selects and closes, published
// months carry a green dot and nothing else is reachable.
//
// The period is a navigation (`?m=`, the four grammars of lib/finance/period),
// which is what keeps a refresh and a shared link on the same period; the chip
// filter is local state mirrored into `?f=`. A month shows what it always
// showed — the chart and the "N of M months" line belong to a period that
// spans more than one month. Every amount is in whole shekels (fmtIls); the
// KPIs come from the server's exact totals; income green-ink, expense
// red-ink, the difference by its sign, the bank balance neutral (28/09/2026).
//
// Every category row (income and expense) is a toggle (06/10/2026): a click
// anywhere on it opens the category's trend over the newest published months
// (PortalCategoryTrend — its own request, NOT the picker's period); the row's
// amount stays the period's total.

const FILTERS: ReadonlyArray<{ key: TxFilter; label: string }> = [
  { key: 'all', label: 'הכל' },
  { key: 'in', label: 'הכנסות' },
  { key: 'out', label: 'הוצאות' },
];

type CatItem = ReturnType<typeof categoriesOf>[number];

function CatRow({ c, color, kind, preview }: { c: CatItem; color: string; kind: FinKind; preview: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="cat-it">
      <button
        type="button"
        className="cat cat-tg"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="n"><i style={{ background: color }} /><em title={c.name}>{c.name}</em></span>
        <span className={`a num ${kind === 'income' ? 'in' : 'out'}`}>{fmtIls(c.total)}<small>{c.pct}%</small></span>
        <span className="chev" aria-hidden><ChevronIcon /></span>
        <span className="bar"><b style={{ width: `${c.bar}%`, background: color }} /></span>
      </button>
      {open && (
        <div className="cat-trend" id={panelId}>
          <PortalCategoryTrend categoryId={c.id} name={c.name} kind={kind} preview={preview} />
        </div>
      )}
    </div>
  );
}

function Cats({ title, kind, items, preview }: { title: string; kind: FinKind; items: CatItem[]; preview: boolean }) {
  return (
    <div className="card c6">
      <h3>{title}</h3>
      <div className="cats tgl">
        {items.length === 0 && <p className="note">אין תנועות.</p>}
        {items.map((c, i) => <CatRow key={c.id} c={c} color={catColor(i)} kind={kind} preview={preview} />)}
      </div>
    </div>
  );
}

export function PortalTransactions({ period, publishedMonths, data, filter: initialFilter, preview }: {
  /** The selected period — already checked against the published months. */
  period: Period;
  /** 'YYYY-MM', newest first. */
  publishedMonths: string[];
  data: ResidentPeriodData;
  filter: TxFilter;
  /** The admin preview (/finance?view=resident): no portal session there. */
  preview: boolean;
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<TxFilter>(initialFilter);
  const [exporting, setExporting] = useState(false);

  function changeFilter(next: TxFilter) {
    setFilter(next);
    window.history.replaceState(window.history.state, '', href({ tab: 'tx', m: period.key, f: next === 'all' ? null : next }));
  }

  const op = data.operating;
  const label = periodLabel(period);
  const isMonth = period.kind === 'month';
  const shown = data.months.filter((m) => m.included);
  const all = [...op.income, ...op.expense];
  const rows = flatEntries(all, filter);
  const showsDocs = all.some((e) => (e.documents?.length ?? 0) > 0);
  const empty = data.months.length === 0 || shown.length === 0;

  // One column per month residents actually get — a hidden month is not a
  // gap in the chart, it is simply not there.
  const points: ChartPoint[] = shown.map((m) => ({
    key: m.month,
    label: monthShort(m.month),
    bars: [
      { value: m.income, fill: '#3D5AFE' },
      { value: m.expense, fill: m.expense > m.income ? '#E5484D' : '#FDA4A7' },
    ],
    tip: [
      { label: 'הכנסות', value: fmtIls(m.income), tone: 'in' },
      { label: 'הוצאות', value: fmtIls(m.expense), tone: 'out' },
    ],
  }));

  async function exportExcel() {
    if (exporting || rows.length === 0) return;
    setExporting(true);
    try {
      await exportPortalPeriodExcel({ period, filter, rows });
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
          <p>כל תנועה בקופת הבניין{showsDocs ? ', כולל חשבוניות וקבלות' : ''} — {label}</p>
        </div>
        <div className="per" style={pending ? { opacity: 0.7 } : undefined}>
          <PeriodPicker period={period} publishedMonths={publishedMonths} residentMode variant="portal" />
          <button type="button" className="pbtn pbtn-secondary" onClick={exportExcel} disabled={exporting || rows.length === 0}>
            <ExportIcon />ייצוא לאקסל
          </button>
        </div>
      </div>

      {empty ? (
        <div className="card empty"><h2>{isMonth ? 'החודש הזה לא פורסם.' : 'התקופה הזו עדיין לא פורסמה.'}</h2></div>
      ) : (
        <div className="pgrid">
          {!isMonth && (
            <div className="c12 note">
              <InfoIcon />
              <span>כולל <b className="num">{shown.length}</b> מתוך <b className="num">{data.months.length}</b> חודשים.</span>
            </div>
          )}

          <div className="kpis c12" data-count={data.bank_balance !== undefined ? 4 : 3}>
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
              <div className="d">{op.totals.diff < 0 ? <span className="dn">גירעון ב{isMonth ? 'חודש' : 'תקופה'}</span> : <span className="up">עודף ב{isMonth ? 'חודש' : 'תקופה'}</span>}</div>
            </div>
            {data.bank_balance !== undefined && (
              <div className="card kpi">
                <span className="kpi-ic" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><WalletIcon /></span>
                <div className="k">יתרת בנק לסוף {isMonth ? 'החודש' : 'התקופה'}</div>
                <div className="v num">{fmtSigned(data.bank_balance)}</div>
                <div className="d">{monthTitle(data.bank_balance_month ?? period.to)}</div>
              </div>
            )}
          </div>

          {!isMonth && (
            <div className="card c12">
              <h3>
                הכנסות מול הוצאות
                <div className="legend">
                  <span><i style={{ background: 'var(--brand)' }} />הכנסות</span>
                  <span><i style={{ background: '#FDA4A7' }} />הוצאות</span>
                </div>
              </h3>
              <PortalBarChart points={points} onPick={(key) => startTransition(() => router.push(href({ tab: 'tx', m: key, f: filter === 'all' ? null : filter })))} ariaLabel="הכנסות מול הוצאות לפי חודש" />
            </div>
          )}

          <div className="card c12">
            <div className="chips" role="group" aria-label="סינון">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className={`chipf${filter === f.key ? ' on' : ''}`} aria-pressed={filter === f.key} onClick={() => changeFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <PortalTxTable rows={rows} emptyText={filter === 'in' ? `אין הכנסות ב${label}.` : filter === 'out' ? `אין הוצאות ב${label}.` : `אין תנועות ב${label}.`} />
          </div>

          {filter !== 'out' && <Cats title="הכנסות לפי קטגוריה" kind="income" items={categoriesOf(op.income, 'income')} preview={preview} />}
          {filter !== 'in' && <Cats title="הוצאות לפי קטגוריה" kind="expense" items={categoriesOf(op.expense, 'expense')} preview={preview} />}
        </div>
      )}
    </section>
  );
}

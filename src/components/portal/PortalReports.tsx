'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { periodLabel, type Period } from '@/lib/finance/period';
import type { FinKind } from '@/lib/constants/finance';
import type { PeriodReport, PeriodReportCategory } from '@/lib/types/finance';
import { fmtIls, fmtSigned, monthShort, signClass, sumExact } from '@/lib/portal/ui';
import { PortalBarChart, type ChartPoint } from './PortalBarChart';
import { PortalSoon } from './PortalSoon';
import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, InfoIcon, ReportsIcon, ScaleIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The reports tab: the period report the old picker opened for a quarter, a
// half or a year — same functions, same figures (getPeriodReport with
// publishedOnly), now behind a `.sel` of every range that holds a published
// month. Three KPIs, the "כולל N מתוך M חודשים" line, then the income and the
// expense categories (total + monthly average) in `.tw` tables; a row opens
// the category's months as a drawChart-style bar chart. Only months residents
// get (included) are drawn — a hidden month appears nowhere. Amounts are
// whole shekels; the totals row is the exact sum of the categories, rounded
// once; income figures are green-ink, expense figures red-ink, the surplus by
// its sign (decision 28/09/2026).

const KIND_FILL: Record<FinKind, string> = { income: '#3D5AFE', expense: '#FDA4A7' };

function CategoryTable({ kind, title, categories, months, divisor }: {
  kind: FinKind;
  title: string;
  categories: PeriodReportCategory[];
  /** Included ('YYYY-MM') months, oldest first. */
  months: string[];
  divisor: number;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const total = sumExact(categories.map((c) => c.total));
  const tone = kind === 'income' ? 'in' : 'out';
  const amt = `amt num ${tone}`;

  return (
    <div className="card c12">
      <h3>{title}<small><span className="num">{categories.length}</span> סעיפים</small></h3>
      {categories.length === 0 ? (
        <p className="note" style={{ marginTop: 14 }}>אין {kind === 'income' ? 'הכנסות' : 'הוצאות'} בתקופה.</p>
      ) : (
        <div className="tw rep">
          <table>
            <thead><tr><th>סעיף</th><th>סה״כ</th><th>ממוצע חודשי</th></tr></thead>
            <tbody>
              {categories.map((c) => {
                const open = openId === c.category_id;
                const points: ChartPoint[] = months.map((m) => ({
                  key: m,
                  label: monthShort(m),
                  bars: [{ value: c.by_month[m] ?? 0, fill: KIND_FILL[kind] }],
                  tip: [{ label: c.name, value: fmtIls(c.by_month[m] ?? 0), tone }],
                }));
                return (
                  <FragmentRows key={c.category_id}>
                    <tr className={`exp${open ? ' open' : ''}`} onClick={() => setOpenId(open ? null : c.category_id)} aria-expanded={open}>
                      <td>
                        <div className="ds">
                          <span className="chev"><ChevronIcon /></span>
                          {c.name}
                          {c.is_hot_water && <span className="tag t-gray" style={{ marginInlineStart: 8 }}>מים חמים</span>}
                        </div>
                      </td>
                      <td><span className={amt}>{fmtIls(c.total)}</span></td>
                      <td><span className={amt} style={{ fontWeight: 500 }}>{fmtIls(c.average)}</span></td>
                    </tr>
                    {open && (
                      <tr className="sub">
                        <td colSpan={3}>
                          <PortalBarChart points={points} ariaLabel={`${c.name} לפי חודש`} />
                        </td>
                      </tr>
                    )}
                  </FragmentRows>
                );
              })}
              <tr className="tot">
                <td><div className="ds">סה״כ</div></td>
                <td><span className={amt}>{fmtIls(total)}</span></td>
                <td><span className={amt} style={{ fontWeight: 500 }}>{fmtIls(total / divisor)}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function PortalReports({ ranges, range, report }: {
  ranges: Period[];
  range: Period | null;
  report: PeriodReport | null;
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [pending, startTransition] = useTransition();

  if (!range || !report) {
    return (
      <PortalSoon icon={<ReportsIcon />} title="דוחות" text="דוחות רבעוניים, חצי-שנתיים ושנתיים יוצגו כאן ברגע שחברת הניהול תפרסם חודשים." />
    );
  }

  const shown = report.months.filter((m) => m.included).map((m) => m.month);
  const divisor = Math.max(1, shown.length);
  const byYear = new Map<number, Period[]>();
  for (const p of ranges) {
    const list = byYear.get(p.year);
    if (list) list.push(p); else byYear.set(p.year, [p]);
  }

  return (
    <section id="t-rep">
      <div className="hd">
        <div>
          <h1>דוחות</h1>
          <p>דוח תקופה — {periodLabel(range)}</p>
        </div>
        <div className="per" style={pending ? { opacity: 0.7 } : undefined}>
          <select className="sel" aria-label="תקופת הדוח" value={range.key} onChange={(e) => { const k = e.target.value; startTransition(() => router.push(href({ tab: 'rep', r: k }))); }}>
            {[...byYear.entries()].map(([year, list]) => (
              <optgroup key={year} label={String(year)}>
                {list.map((p) => <option key={p.key} value={p.key}>{periodLabel(p)}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {report.months.length === 0 ? (
        <div className="card empty"><h2>התקופה עדיין לא התחילה.</h2></div>
      ) : (
        <div className="pgrid">
          <div className="c12 note">
            <InfoIcon />
            <span>כולל <b className="num">{shown.length}</b> מתוך <b className="num">{report.months.length}</b> חודשים.</span>
          </div>

          <div className="kpis c12" data-count={3}>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><ArrowUpIcon /></span>
              <div className="k">הכנסות</div>
              <div className="v num in">{fmtIls(report.totals.income)}</div>
              <div className="d">{periodLabel(range)}</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><ArrowDownIcon /></span>
              <div className="k">הוצאות</div>
              <div className="v num out">{fmtIls(report.totals.expense)}</div>
              <div className="d">{periodLabel(range)}</div>
            </div>
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: report.totals.surplus < 0 ? 'var(--amber-soft)' : 'var(--brand-soft)', color: report.totals.surplus < 0 ? 'var(--amber)' : 'var(--brand)' }}><ScaleIcon /></span>
              <div className="k">עודף בתקופה</div>
              <div className={`v num ${signClass(report.totals.surplus)}`}>{fmtSigned(report.totals.surplus)}</div>
              <div className="d">{report.totals.surplus < 0 ? <span className="dn">גירעון בתקופה</span> : <><span className="num">{report.months.length}</span> חודשים</>}</div>
            </div>
          </div>

          <CategoryTable kind="income" title="הכנסות לפי סעיף" categories={report.income} months={shown} divisor={divisor} />
          <CategoryTable kind="expense" title="הוצאות לפי סעיף" categories={report.expense} months={shown} divisor={divisor} />
        </div>
      )}
    </section>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ResidentOverview } from '@/lib/types/finance';
import { PORTAL_BLOCKS } from '@/lib/portal/blocks';
import {
  catColor, categoryShares, fmtIls, monthName, monthShort, monthTitle, pctVsAverage, sumOverWindow, windowKeys,
  type OverviewSpan,
} from '@/lib/portal/ui';
import { PortalBarChart, type ChartPoint } from './PortalBarChart';
import { PortalTxTable } from './PortalTxTable';
import { ArrowDownIcon, ArrowUpIcon, DecisionsIcon, WalletIcon } from './PortalIcons';

// The overview tab (#t-ov of the reference): greeting + "updated to <newest
// published month>", the 12/6-month period select, the KPIs of the newest
// month, income vs. expenses per month, where the money goes, the five newest
// lines and the "decisions — coming soon" card. Everything comes from
// ResidentOverview (published months only); the 6-month view is a slice of the
// 12-month data set, so the select never leaves the page — it only rewrites
// `?n=` so a refresh keeps it.
//
// Three reference blocks are switched off through PORTAL_BLOCKS (my balance,
// building cash balance, collection rate); their markup stays so switching one
// on restores the reference grid. With the cash KPI off the two KPIs share the
// row (c6 each on the desktop, two columns on a phone).

export function PortalOverview({ overview, span: initialSpan, greeting }: {
  overview: ResidentOverview;
  span: OverviewSpan;
  /** The owner's first name, or null. */
  greeting: string | null;
}) {
  const router = useRouter();
  const [span, setSpan] = useState<OverviewSpan>(initialSpan);

  function changeSpan(next: OverviewSpan) {
    setSpan(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'ov');
    url.searchParams.set('n', String(next));
    window.history.replaceState(window.history.state, '', url);
  }

  const keys = windowKeys(overview.latest, span);
  const inWindow = new Set(keys);
  const months = overview.months.filter((m) => inWindow.has(m.month));
  const latest = months.find((m) => m.month === overview.latest) ?? { month: overview.latest, income: 0, expense: 0 };
  const expensePct = pctVsAverage(latest.expense, months.map((m) => m.expense));
  const cats = categoryShares(overview.expense_categories.map((c) => ({ name: c.name, total: sumOverWindow(c.by_month, keys) })));
  const points: ChartPoint[] = months.map((m) => ({
    key: m.month,
    label: monthShort(m.month),
    bars: [
      { value: m.income, fill: '#3D5AFE' },
      { value: m.expense, fill: m.expense > m.income ? '#E5484D' : '#FDA4A7' },
    ],
    tip: [
      { label: 'הכנסות', value: fmtIls(m.income) },
      { label: 'הוצאות', value: fmtIls(m.expense) },
    ],
    // No month note exists in the finance model (Phase 0, 28/09/2026) — the
    // line stays conditional so a future note field lights it up.
    note: null,
  }));

  const kpiCount = PORTAL_BLOCKS.cashBalance ? 3 : 2;
  const openMonth = (key: string) => router.push(`/portal?tab=tx&m=${key}`);

  return (
    <section id="t-ov">
      <div className="hd">
        <div>
          <h1>שלום{greeting ? ` ${greeting}` : ''}</h1>
          <p>מצב הכספים של הבניין, מעודכן ל-{monthTitle(overview.latest)}</p>
        </div>
        <div className="per">
          <select className="sel" aria-label="תקופה" value={span} onChange={(e) => changeSpan(e.target.value === '6' ? 6 : 12)}>
            <option value={12}>12 חודשים אחרונים</option>
            <option value={6}>6 חודשים אחרונים</option>
          </select>
        </div>
      </div>

      <div className="pgrid">
        {PORTAL_BLOCKS.myBalance && (
          <div className="card mine c4">
            <div className="lab">היתרה שלך לתשלום</div>
            <div className="big num">—</div>
          </div>
        )}

        <div className={`kpis ${PORTAL_BLOCKS.myBalance ? 'c8' : 'c12'}`} data-count={kpiCount}>
          {PORTAL_BLOCKS.cashBalance && (
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><WalletIcon /></span>
              <div className="k">יתרת קופת הבניין</div>
              <div className="v num">—</div>
            </div>
          )}
          <div className="card kpi">
            <span className="kpi-ic" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><ArrowUpIcon /></span>
            <div className="k">הכנסות · {monthName(overview.latest)}</div>
            <div className="v num">{fmtIls(latest.income)}</div>
            {PORTAL_BLOCKS.collectionRate && <div className="d">—</div>}
          </div>
          <div className="card kpi">
            <span className="kpi-ic" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><ArrowDownIcon /></span>
            <div className="k">הוצאות · {monthName(overview.latest)}</div>
            <div className="v num">{fmtIls(latest.expense)}</div>
            {expensePct !== null && (
              <div className="d">
                <span className={`num ${expensePct > 0 ? 'dn' : expensePct < 0 ? 'up' : ''}`}>
                  {expensePct > 0 ? '+' : expensePct < 0 ? '−' : ''}{Math.abs(expensePct)}%
                </span>
                {span === 12 ? 'מהממוצע השנתי' : 'מהממוצע החצי-שנתי'}
              </div>
            )}
          </div>
        </div>

        <div className="card c8">
          <h3>
            הכנסות מול הוצאות
            <div className="legend">
              <span><i style={{ background: 'var(--brand)' }} />הכנסות</span>
              <span><i style={{ background: '#FDA4A7' }} />הוצאות</span>
            </div>
          </h3>
          <PortalBarChart points={points} onPick={openMonth} ariaLabel="הכנסות מול הוצאות לפי חודש" />
        </div>

        <div className="card c4">
          <h3>לאן הולך הכסף<small><span className="num">{span}</span> חודשים</small></h3>
          <div className="cats">
            {cats.length === 0 && <p className="note">אין הוצאות בתקופה.</p>}
            {cats.map((c, i) => (
              <div className="cat" key={c.name}>
                <span className="n"><i style={{ background: catColor(i) }} /><em title={c.name}>{c.name}</em></span>
                <span className="a num">{fmtIls(c.total)}<small>{c.pct}%</small></span>
                <div className="bar"><b style={{ width: `${c.bar}%`, background: catColor(i) }} /></div>
              </div>
            ))}
          </div>
        </div>

        <div className="card c8">
          <h3>
            תנועות אחרונות
            <a href="/portal?tab=tx" style={{ fontSize: 14 }} onClick={(e) => { e.preventDefault(); router.push('/portal?tab=tx'); }}>לכל התנועות</a>
          </h3>
          <PortalTxTable rows={overview.recent} emptyText="אין תנועות עדיין." />
        </div>

        <div className="c4 col">
          {PORTAL_BLOCKS.collectionRate && (
            <div className="card"><h3>שיעור גבייה · {monthName(overview.latest)}</h3></div>
          )}
          <div className="card">
            <div className="fut">
              <div className="ic"><DecisionsIcon /></div>
              <div>
                <h4>החלטות ועד <span className="soon">בקרוב</span></h4>
                <p>הצבעות דיירים, פרוטוקולים ואישור תקציב — ישירות מהפורטל.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

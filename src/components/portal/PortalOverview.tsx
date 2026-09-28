'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ResidentOverview } from '@/lib/types/finance';
import type { PortalAccount } from '@/lib/types/portal';
import { PORTAL_BLOCKS } from '@/lib/portal/blocks';
import {
  accountTotals, apartmentsLabel, catColor, categoryShares, fmtDateDMY, fmtDelta, fmtIls, fmtSigned, monthName,
  monthShort, monthTitle, pctVsAverage, roundShekels, sumOverWindow, windowKeys, type OverviewSpan,
} from '@/lib/portal/ui';
import { PortalBarChart, type ChartPoint } from './PortalBarChart';
import { PortalTxTable } from './PortalTxTable';
import { ArrowDownIcon, ArrowUpIcon, DecisionsIcon, WalletIcon } from './PortalIcons';
import { usePortalHref } from './usePortalHref';

// The overview tab (#t-ov of the reference): greeting + "updated to <newest
// published month>", the 12/6-month period select, the KPIs of the newest
// month, income vs. expenses per month, where the money goes, the five newest
// lines and the "decisions — coming soon" card. Everything comes from
// ResidentOverview (published months only); the 6-month view is a slice of the
// 12-month data set, so the select never leaves the page — it only rewrites
// `?n=` so a refresh keeps it.
//
// The reference's blocks come and go with their data (PORTAL_BLOCKS): the dark
// card needs an account, the cash KPI needs a bank balance (the switch and a
// value), the collection ring has no data and stays off. Without the cash KPI
// the two KPIs share the row (c6 each on the desktop, two columns on a phone).
//
// Amounts: whole shekels everywhere (fmtIls), computed from the exact figures;
// the income KPI is green-ink, the expense KPI red-ink, the category list
// red-ink, the tooltip lines by kind; the bank balance and the dark card stay
// neutral (decision 28/09/2026).

/** The dark "היתרה שלך לתשלום" card (the reference's .mine): the owner's
 *  balance due summed over their records (an archived apartment counts like
 *  any other), the management / hot-water split, "as of" the last sync, and
 *  a link to the full account. */
function MyBalanceCard({ accounts, onMore }: { accounts: readonly PortalAccount[]; onMore: () => void }) {
  const t = accountTotals(accounts);
  const asOf = fmtDateDMY(accounts[0]?.synced_at ?? null);
  const label = accounts.length > 1 ? apartmentsLabel(accounts.map((a) => a.apartment_number)) : null;
  const inDebt = roundShekels(t.total) > 0;
  return (
    <div className="card mine c4">
      <div className="lab">
        היתרה שלך לתשלום
        {inDebt
          ? <span className="tag t-red"><i />חוב פתוח</span>
          : <span className="tag t-ok"><i />אין חוב</span>}
      </div>
      <div className="big num">{fmtIls(t.total)}</div>
      <div className="row2">
        <span>דמי ניהול <b className="num">{fmtIls(t.management)}</b></span>
        <span>מים חמים <b className="num">{fmtIls(t.hotWater)}</b></span>
      </div>
      {(label || asOf) && (
        <div className="asof">
          {label}
          {label && asOf ? ' · ' : ''}
          {asOf && <>נכון ל-<span className="num">{asOf}</span></>}
        </div>
      )}
      <button type="button" className="pbtn pbtn-lg pbtn-more" onClick={onMore}>לפירוט המלא</button>
    </div>
  );
}

export function PortalOverview({ overview, span: initialSpan, greeting, accounts }: {
  overview: ResidentOverview;
  span: OverviewSpan;
  /** The owner's first name, or null. */
  greeting: string | null;
  /** The owner's account(s) for the dark card; empty = no card. */
  accounts: readonly PortalAccount[];
}) {
  const router = useRouter();
  const href = usePortalHref();
  const [span, setSpan] = useState<OverviewSpan>(initialSpan);

  function changeSpan(next: OverviewSpan) {
    setSpan(next);
    window.history.replaceState(window.history.state, '', href({ tab: 'ov', n: String(next) }));
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
      { label: 'הכנסות', value: fmtIls(m.income), tone: 'in' },
      { label: 'הוצאות', value: fmtIls(m.expense), tone: 'out' },
    ],
    // No month note exists in the finance model (Phase 0, 28/09/2026) — the
    // line stays conditional so a future note field lights it up.
    note: null,
  }));

  const bank = PORTAL_BLOCKS.cashBalance ? overview.bank_balance : undefined;
  const showMine = PORTAL_BLOCKS.myBalance && accounts.length > 0;
  const kpiCount = bank ? 3 : 2;
  const openMonth = (key: string) => router.push(href({ tab: 'tx', m: key }));
  const bankDelta = bank?.previous ? bank.value - bank.previous.value : null;

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
        {showMine && <MyBalanceCard accounts={accounts} onMore={() => router.push(href({ tab: 'acc' }))} />}

        <div className={`kpis ${showMine ? 'c8' : 'c12'}`} data-count={kpiCount}>
          {bank && (
            <div className="card kpi">
              <span className="kpi-ic" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><WalletIcon /></span>
              <div className="k">יתרת קופת הבניין · {monthName(bank.month)}</div>
              <div className="v num">{fmtSigned(bank.value)}</div>
              {bankDelta !== null && (
                <div className="d">
                  <span className={`num ${bankDelta > 0 ? 'up' : bankDelta < 0 ? 'dn' : ''}`}>{fmtDelta(bankDelta)}</span>
                  מול החודש הקודם
                </div>
              )}
            </div>
          )}
          <div className="card kpi">
            <span className="kpi-ic" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><ArrowUpIcon /></span>
            <div className="k">הכנסות · {monthName(overview.latest)}</div>
            <div className="v num in">{fmtIls(latest.income)}</div>
            {PORTAL_BLOCKS.collectionRate && <div className="d">—</div>}
          </div>
          <div className="card kpi">
            <span className="kpi-ic" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><ArrowDownIcon /></span>
            <div className="k">הוצאות · {monthName(overview.latest)}</div>
            <div className="v num out">{fmtIls(latest.expense)}</div>
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
                <span className="a num out">{fmtIls(c.total)}<small>{c.pct}%</small></span>
                <div className="bar"><b style={{ width: `${c.bar}%`, background: catColor(i) }} /></div>
              </div>
            ))}
          </div>
        </div>

        <div className="card c8">
          <h3>
            תנועות אחרונות
            <a href={href({ tab: 'tx' })} style={{ fontSize: 14 }} onClick={(e) => { e.preventDefault(); router.push(href({ tab: 'tx' })); }}>לכל התנועות</a>
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

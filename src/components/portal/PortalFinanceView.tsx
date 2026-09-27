'use client';

import { periodLabel, type Period } from '@/lib/finance/period';
import type { PeriodReport, ResidentFundKpis, ResidentMonthData } from '@/lib/types/finance';
import { FinanceTabs, type FinanceTab } from '@/components/finance/FinanceTabs';
import { FundTab } from '@/components/finance/FundTab';
import { PeriodPicker } from '@/components/finance/PeriodPicker';
import { PeriodReportView } from '@/components/finance/PeriodReportView';
import { ResidentMonthView } from '@/components/finance/ResidentMonthView';

// The resident's screen on /portal. It composes the SAME resident-view
// components the admin's `?view=resident` preview uses — FinanceTabs,
// PeriodPicker (residentMode), ResidentMonthView, PeriodReportView, FundTab —
// rather than re-implementing any of them. What it does NOT reuse is
// ResidentViewClient itself: that one carries the admin's "you are viewing as a
// resident" banner and the toggle out of it, which are meaningless here.
//
// Every figure arrives already restricted to published months (portal.ts with
// publishedOnly = true), so there is nothing to hide client-side: no supplier,
// invoice number, note, file, action or publish switch exists in these props.
//
// Navigation is query-string only (`?tab=` / `?m=`) and every one of these
// components reads usePathname(), so they route under /portal unchanged.

export function PortalFinanceView({ tab, period, publishedMonths, monthData, report, fund }: {
  tab: FinanceTab;
  /** null = nothing published yet. */
  period: Period | null;
  publishedMonths: string[];
  monthData: ResidentMonthData | null;
  report: PeriodReport | null;
  fund: ResidentFundKpis | null;
}) {
  const isFund = tab === 'fund';
  const nothingPublished = publishedMonths.length === 0 || period === null;

  const subtitle = nothingPublished
    ? 'הדוחות יוצגו כאן ברגע שחברת הניהול תפרסם אותם.'
    : isFund
      ? 'קרן השיפוצים — מצטבר מכל החודשים שפורסמו.'
      : period.kind === 'month'
        ? `הכנסות והוצאות הבניין — ${periodLabel(period)}`
        : `דוח תקופה — ${periodLabel(period)}`;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">שקיפות כספית</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <FinanceTabs active={tab} />
        </div>

        {!nothingPublished && !isFund && (
          <div className="flex flex-wrap items-center gap-3">
            <PeriodPicker period={period} publishedMonths={publishedMonths} residentMode />
          </div>
        )}
      </header>

      {nothingPublished ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
          עוד לא פורסמו חודשים.
        </div>
      ) : isFund ? (
        fund && (
          <FundTab
            kpis={fund}
            canEdit={false}
            residentMode
            onEdit={() => undefined}
            onDelete={() => undefined}
            onTargetSaved={() => undefined}
          />
        )
      ) : period.kind === 'month' ? (
        monthData
          ? <ResidentMonthView data={monthData} period={period} />
          : <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">החודש הזה לא פורסם.</div>
      ) : (
        report && <PeriodReportView report={report} period={period} residentMode />
      )}
    </div>
  );
}

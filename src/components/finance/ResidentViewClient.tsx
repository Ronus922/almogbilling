'use client';

import { Eye, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { periodLabel, type Period } from '@/lib/finance/period';
import type { PeriodReport, ResidentFundKpis, ResidentMonthData } from '@/lib/types/finance';
import { FinanceTabs, type FinanceTab } from './FinanceTabs';
import { FundTab } from './FundTab';
import { PeriodPicker } from './PeriodPicker';
import { PeriodReportView } from './PeriodReportView';
import { ResidentMonthView } from './ResidentMonthView';
import { ResidentViewToggle, useResidentViewNav } from './ResidentViewToggle';

// /finance?view=resident — what a resident will get from the future portal,
// rendered for the admin now. Everything on this screen comes from
// portal.ts with publishedOnly = true; no admin data reaches this component,
// so nothing has to be hidden client-side: there are no supplier names,
// invoice numbers, notes, files, actions, publish switches or "לא פורסם"
// tags in the props to begin with. A permanent banner says so, with the way out.

export function ResidentViewClient({ tab, period, publishedMonths, monthData, report, fund }: {
  tab: FinanceTab;
  /** null = nothing published yet. */
  period: Period | null;
  publishedMonths: string[];
  monthData: ResidentMonthData | null;
  report: PeriodReport | null;
  fund: ResidentFundKpis | null;
}) {
  const { set, pending } = useResidentViewNav();
  const isFund = tab === 'fund';
  const nothingPublished = publishedMonths.length === 0 || period === null;

  const subtitle = nothingPublished
    ? 'כך ייראה המסך לבעלי הדירות.'
    : isFund
      ? 'קרן השיפוצים — מצטבר מהחודשים שפורסמו.'
      : period.kind === 'month'
        ? `הכנסות והוצאות הבניין — ${periodLabel(period)}`
        : `דוח תקופה — ${periodLabel(period)}`;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">שקיפות כספית</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <FinanceTabs active={tab} />
            <ResidentViewToggle active />
          </div>
        </div>

        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
          <span className="flex items-center gap-2 font-semibold">
            <Eye className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
            אתה צופה כמו דייר — מוצגים רק חודשים שפורסמו, בלי פרטים פנימיים.
          </span>
          <Button type="button" variant="outline" onClick={() => set(false)} disabled={pending} className="gap-2">
            <LogOut className="h-4 w-4" aria-hidden /> יציאה מתצוגת דייר
          </Button>
        </div>

        {!nothingPublished && !isFund && (
          <div className="flex flex-wrap items-center gap-3">
            <PeriodPicker period={period} publishedMonths={publishedMonths} residentMode />
          </div>
        )}
      </header>

      {nothingPublished ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">עוד לא פורסמו חודשים.</div>
      ) : isFund ? (
        fund && <FundTab kpis={fund} canEdit={false} residentMode onEdit={() => undefined} onDelete={() => undefined} onTargetSaved={() => undefined} />
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

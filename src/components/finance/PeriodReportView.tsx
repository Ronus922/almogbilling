'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KpiCard } from '@/components/KpiCard';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import { monthLabel, periodLabel, type Period } from '@/lib/finance/period';
import { HE_MONTH_NAMES } from '@/lib/constants/calendar';
import type { FinKind } from '@/lib/constants/finance';
import type { PeriodReport, PeriodReportCategory } from '@/lib/types/finance';
import { COL_PX, HEAD_CLASS } from './table-shared';

// The period report of the operating budget (a quarter, a half or a year):
// three KPIs, then the income and the expense categories with their total and
// monthly average. A category row opens a bar chart of its months. Fund lines
// are never in here. When the range holds months hidden from residents, the
// banner says how much of the range THEY would get.

const TONE: Record<FinKind, { text: string; bar: string }> = {
  income: { text: 'text-emerald-700', bar: '#16a34a' },
  expense: { text: 'text-rose-700', bar: '#e5484d' },
};

/** "ספטמבר 2026 מוסתר מדיירים" · "אוגוסט 2026, ספטמבר 2026 מוסתרים מדיירים" · "5 חודשים מוסתרים מדיירים". */
function hiddenLabel(months: string[]): string {
  if (months.length === 1) return `${monthLabel(months[0])} מוסתר מדיירים`;
  if (months.length <= 3) return `${months.map(monthLabel).join(', ')} מוסתרים מדיירים`;
  return `${months.length} חודשים מוסתרים מדיירים`;
}

interface TipProps {
  active?: boolean;
  label?: string | number;
  payload?: { value?: number }[];
}

function ChartTooltip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div dir="rtl" className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-soft-md">
      <div className="mb-1 font-bold text-ink">{label}</div>
      <div className="font-num font-semibold text-ink">{ils(Number(payload[0]?.value ?? 0))}</div>
    </div>
  );
}

/** Bars per month of the range for one category (0 for a month without lines).
 *  recharts is LTR inside, so the SVG is wrapped dir="ltr" and the X axis is
 *  reversed to read right→left (the CollectionChart convention). */
function CategoryChart({ category, months }: { category: PeriodReportCategory; months: string[] }) {
  const data = months.map((m) => ({
    key: m,
    label: months.length > 6 ? HE_MONTH_NAMES[Number(m.slice(5, 7)) - 1].slice(0, 3) : HE_MONTH_NAMES[Number(m.slice(5, 7)) - 1],
    total: category.by_month[m] ?? 0,
  }));
  return (
    <div dir="ltr" className="h-[220px] w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 8 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="#eef1f6" />
          <XAxis dataKey="label" reversed tickLine={false} axisLine={{ stroke: '#e2e7f0' }} tick={{ fontSize: 12, fill: '#64748b', fontWeight: 600 }} />
          <YAxis
            orientation="right"
            width={46}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)}
          />
          <Tooltip cursor={{ fill: 'rgba(61,90,254,0.06)' }} content={<ChartTooltip />} />
          <Bar dataKey="total" name={category.name} fill={TONE[category.kind].bar} radius={[6, 6, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CategoryTable({ kind, categories, months, emptyText }: {
  kind: FinKind;
  categories: PeriodReportCategory[];
  months: string[];
  emptyText: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const tone = TONE[kind];
  const total = categories.reduce((s, c) => s + c.total, 0);
  const divisor = Math.max(1, months.length);

  if (categories.length === 0) {
    return <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <>
      {/* Phones: cards */}
      <div className="space-y-2 roomy:hidden">
        {categories.map((c) => {
          const isOpen = openId === c.category_id;
          return (
            <div key={c.category_id} className="rounded-xl border border-line bg-white shadow-soft-xs">
              <button type="button" onClick={() => toggle(c.category_id)} aria-expanded={isOpen} className="flex w-full items-center gap-3 p-4 text-start">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                  <p className="mt-1 text-xs text-ink-3">ממוצע חודשי <span dir="ltr" className="font-num tabular-nums">{ils(c.average)}</span></p>
                </div>
                <span dir="ltr" className={cn('shrink-0 font-num text-base font-bold tabular-nums', tone.text)}>{ils(c.total)}</span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} aria-hidden />
              </button>
              {isOpen && <div className="border-t border-line-soft p-3"><CategoryChart category={c} months={months} /></div>}
            </div>
          );
        })}
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm font-bold text-ink">
          <span>סה״כ</span>
          <span dir="ltr" className={cn('font-num tabular-nums', tone.text)}>{ils(total)}</span>
        </div>
      </div>

      {/* Desktop: table — the two numeric columns use the shared amount width. */}
      <div className="hidden overflow-hidden rounded-xl border border-line bg-white roomy:block">
        <Table className="table-fixed">
          <colgroup>
            <col />
            <col style={{ width: COL_PX.amount }} />
            <col style={{ width: COL_PX.amount }} />
          </colgroup>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-line">
            <TableRow className="bg-surface-2 hover:bg-surface-2">
              <TableHead className={cn(HEAD_CLASS, 'text-start')}>סעיף</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>סה״כ</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>ממוצע חודשי</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((c) => {
              const isOpen = openId === c.category_id;
              return (
                <CategoryRows key={c.category_id} category={c} months={months} isOpen={isOpen} onToggle={() => toggle(c.category_id)} tone={tone.text} />
              );
            })}
            <TableRow className="border-t border-line bg-surface-2 hover:bg-surface-2">
              <TableCell className="px-4 py-3 text-start text-sm font-bold text-ink">סה״כ</TableCell>
              <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', tone.text)}>{ils(total)}</TableCell>
              <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm font-semibold tabular-nums text-ink-2">{ils(total / divisor)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function CategoryRows({ category: c, months, isOpen, onToggle, tone }: {
  category: PeriodReportCategory; months: string[]; isOpen: boolean; onToggle: () => void; tone: string;
}) {
  return (
    <>
      <TableRow
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn('h-[46px] cursor-pointer border-b border-line-soft hover:bg-row-hover', isOpen && 'bg-slate-50/70')}
      >
        <TableCell className="px-4 py-3 text-start text-sm font-medium text-ink">
          <span className="inline-flex items-center gap-2">
            <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-180')} aria-hidden />
            <span className="truncate" title={c.name}>{c.name}</span>
            {c.is_hot_water && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">מים חמים</span>}
          </span>
        </TableCell>
        <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', tone)}>{ils(c.total)}</TableCell>
        <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm tabular-nums text-ink-2">{ils(c.average)}</TableCell>
      </TableRow>
      {isOpen && (
        <TableRow className="border-b border-line-soft bg-white hover:bg-white">
          <TableCell colSpan={3} className="p-4">
            <CategoryChart category={c} months={months} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function PeriodReportView({ report, period }: { report: PeriodReport; period: Period }) {
  const months = report.months.map((m) => m.month);
  const hidden = report.months.filter((m) => !m.published).map((m) => m.month);
  const shown = report.months.length - hidden.length;
  const label = periodLabel(period);

  return (
    <div className="space-y-6">
      {hidden.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <p>
            {hiddenLabel(hidden)} — אצלם הדוח יכלול{' '}
            <span className="font-num font-bold tabular-nums">{shown}</span> מתוך{' '}
            <span className="font-num font-bold tabular-nums">{report.months.length}</span> חודשים.
          </p>
        </div>
      )}

      {report.months.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">התקופה עדיין לא התחילה.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard title="הכנסות" value={ils(report.totals.income)} subtitle={label} tone="green" icon={TrendingUp} />
            <KpiCard title="הוצאות" value={ils(report.totals.expense)} subtitle={label} tone="red" icon={TrendingDown} />
            <KpiCard
              title="עודף בתקופה"
              value={ils(report.totals.surplus)}
              subtitle={report.totals.surplus < 0 ? 'גירעון בתקופה' : `${report.months.length} חודשים`}
              tone={report.totals.surplus < 0 ? 'amber' : 'cyan'}
              icon={Scale}
            />
          </div>

          <section className="space-y-3">
            <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
              הכנסות לפי סעיף
              <span className="font-num text-sm font-medium tabular-nums text-slate-400">{report.income.length}</span>
            </h2>
            <CategoryTable kind="income" categories={report.income} months={months} emptyText={`אין הכנסות ב${label}.`} />
          </section>

          <section className="space-y-3">
            <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
              הוצאות לפי סעיף
              <span className="font-num text-sm font-medium tabular-nums text-slate-400">{report.expense.length}</span>
            </h2>
            <CategoryTable kind="expense" categories={report.expense} months={months} emptyText={`אין הוצאות ב${label}.`} />
          </section>
        </>
      )}
    </div>
  );
}

'use client';

import { Scale, TrendingDown, TrendingUp } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KpiCard } from '@/components/KpiCard';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import { periodLabel, type Period } from '@/lib/finance/period';
import type { FinKind } from '@/lib/constants/finance';
import type { ResidentEntry, ResidentMonthData } from '@/lib/types/finance';
import { COL_PX, HEAD_CLASS, fmtDate } from './table-shared';

// One published month as a resident gets it: the operating KPIs and the
// income / expense lines grouped by category — category, description,
// amount (and the payment date of an expense). Built ONLY from
// ResidentMonthData (portal.ts): there is no supplier, invoice number,
// internal note, file or action anywhere in the input, so none can leak.

interface Group { name: string; entries: ResidentEntry[]; total: number }

function groupByCategory(entries: ResidentEntry[]): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    let g = map.get(e.category_name);
    if (!g) {
      g = { name: e.category_name, entries: [], total: 0 };
      map.set(e.category_name, g);
    }
    g.entries.push(e);
    g.total += e.amount;
  }
  return [...map.values()];
}

function ResidentTable({ kind, entries, emptyText }: { kind: FinKind; entries: ResidentEntry[]; emptyText: string }) {
  const groups = groupByCategory(entries);
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const isExpense = kind === 'expense';
  const amountTone = isExpense ? 'text-rose-700' : 'text-emerald-700';
  const colCount = isExpense ? 3 : 2;

  if (entries.length === 0) {
    return <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <>
      {/* Phones: cards */}
      <div className="space-y-4 roomy:hidden">
        {groups.map((g) => (
          <div key={g.name} className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-sm font-bold text-ink">{g.name}</span>
              <span dir="ltr" className={cn('font-num text-sm font-bold tabular-nums', amountTone)}>{ils(g.total)}</span>
            </div>
            <ul className="space-y-2">
              {g.entries.map((e, i) => (
                <li key={i} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-white p-4 shadow-soft-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{e.description || <span className="text-ink-ghost">ללא תיאור</span>}</p>
                    {isExpense && <p dir="ltr" className="mt-1 text-start font-num text-xs tabular-nums text-ink-3">{fmtDate(e.payment_date)}</p>}
                  </div>
                  <span dir="ltr" className={cn('shrink-0 font-num text-base font-bold tabular-nums', amountTone)}>{ils(e.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm font-bold text-ink">
          <span>סה״כ</span>
          <span dir="ltr" className={cn('font-num tabular-nums', amountTone)}>{ils(total)}</span>
        </div>
      </div>

      {/* Desktop: table — the amount column shares the finance-wide width. */}
      <div className="hidden overflow-hidden rounded-xl border border-line bg-white roomy:block">
        <Table className="table-fixed">
          <colgroup>
            {isExpense && <col style={{ width: COL_PX.date }} />}
            <col />
            <col style={{ width: COL_PX.amount }} />
          </colgroup>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-line">
            <TableRow className="bg-surface-2 hover:bg-surface-2">
              {isExpense && <TableHead className={cn(HEAD_CLASS, 'text-center')}>תאריך</TableHead>}
              <TableHead className={cn(HEAD_CLASS, 'text-start')}>תיאור</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>סכום</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <GroupRows key={g.name} group={g} isExpense={isExpense} colCount={colCount} amountTone={amountTone} />
            ))}
            <TableRow className="border-t border-line bg-surface-2 hover:bg-surface-2">
              <TableCell colSpan={colCount - 1} className="px-4 py-3 text-start text-sm font-bold text-ink">סה״כ</TableCell>
              <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function GroupRows({ group: g, isExpense, colCount, amountTone }: { group: Group; isExpense: boolean; colCount: number; amountTone: string }) {
  return (
    <>
      <TableRow className="border-b border-line-soft bg-slate-50/70 hover:bg-slate-50/70">
        <TableCell colSpan={colCount - 1} className="px-4 py-2 text-start text-sm font-bold text-ink">
          <span className="inline-flex items-center gap-2">
            {g.name}
            <span className="text-xs font-medium text-ink-3">{g.entries.length} שורות</span>
          </span>
        </TableCell>
        <TableCell dir="ltr" className={cn('px-4 py-2 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(g.total)}</TableCell>
      </TableRow>
      {g.entries.map((e, i) => (
        <TableRow key={i} className="h-[46px] border-b border-line-soft hover:bg-row-hover">
          {isExpense && (
            <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm tabular-nums text-ink-2">{fmtDate(e.payment_date)}</TableCell>
          )}
          <TableCell className="truncate px-4 py-3 text-start text-sm text-ink" title={e.description}>
            {e.description || <span className="text-ink-ghost">—</span>}
          </TableCell>
          <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(e.amount)}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function ResidentMonthView({ data, period }: { data: ResidentMonthData; period: Period }) {
  const op = data.operating;
  const label = periodLabel(period);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard title="הכנסות" value={ils(op.totals.income)} subtitle="תקציב שוטף" tone="green" icon={TrendingUp} />
        <KpiCard title="הוצאות" value={ils(op.totals.expense)} subtitle="תקציב שוטף" tone="red" icon={TrendingDown} />
        <KpiCard title="הפרש" value={ils(op.totals.diff)} subtitle={op.totals.diff < 0 ? 'גירעון בחודש' : 'עודף בחודש'} tone={op.totals.diff < 0 ? 'amber' : 'cyan'} icon={Scale} />
      </div>

      <section className="space-y-3">
        <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
          הכנסות
          <span className="font-num text-sm font-medium tabular-nums text-slate-400">{op.income.length}</span>
        </h2>
        <ResidentTable kind="income" entries={op.income} emptyText={`אין הכנסות ב${label}.`} />
      </section>

      <section className="space-y-3">
        <h2 className="flex items-baseline gap-2 text-lg font-bold text-slate-900">
          הוצאות
          <span className="font-num text-sm font-medium tabular-nums text-slate-400">{op.expense.length}</span>
        </h2>
        <ResidentTable kind="expense" entries={op.expense} emptyText={`אין הוצאות ב${label}.`} />
      </section>
    </div>
  );
}

'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import type { FundLedgerRow } from '@/lib/types/finance';
import { COL_PX, HEAD_CLASS, RowActions, TABLE_CLASS, fmtDate } from './table-shared';

// "כל תנועות הקרן" — every line of the renovation fund, all months, newest
// first, incomes and expenses in one ledger. Same widths as the operating
// tables (table-shared.tsx) so the numeric and action columns line up with
// them: date 112 · purpose/description (flexible) · income 160 · expense 160 ·
// actions 112. A line from a month that is not published gets a "לא פורסם"
// tag. Desktop: table; phones: cards (`roomy:` variant, like EntryGroupTable).

function UnpublishedBadge() {
  return (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">לא פורסם</span>
  );
}

/** Expense: its payment date. Income: the month it was filed to ('MM/YYYY'). */
function whenOf(e: FundLedgerRow): string {
  if (e.kind === 'expense') return fmtDate(e.payment_date);
  return `${e.period_month.slice(5, 7)}/${e.period_month.slice(0, 4)}`;
}

export function FundLedgerTable({ entries, canEdit, onEdit, onDelete, emptyText, residentMode = false }: {
  /** FundLedgerEntry for the admin; the stripped resident row otherwise. */
  entries: FundLedgerRow[];
  canEdit: boolean;
  onEdit: (e: FundLedgerRow) => void;
  onDelete: (e: FundLedgerRow) => void;
  emptyText: string;
  /** Resident view: no actions column at all, no "לא פורסם" tag. */
  residentMode?: boolean;
}) {
  const showActions = !residentMode;
  const showUnpublished = !residentMode;
  const income = entries.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
  const expense = entries.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0);

  if (entries.length === 0) {
    return <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <>
      {/* Phones: cards */}
      <div className="space-y-2 roomy:hidden">
        <ul className="space-y-2">
          {entries.map((e, i) => (
            <li key={e.id ?? i} className="rounded-xl border border-line bg-white p-4 shadow-soft-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span className="truncate">{e.category_name}</span>
                    {showUnpublished && !e.published && <UnpublishedBadge />}
                  </p>
                  <p className="mt-1 text-xs text-ink-3">
                    <span dir="ltr" className="font-num tabular-nums">{whenOf(e)}</span>
                    {e.description && <> · {e.description}</>}
                  </p>
                </div>
                <span dir="ltr" className={cn('shrink-0 font-num text-base font-bold tabular-nums', e.kind === 'income' ? 'text-emerald-700' : 'text-rose-700')}>
                  {e.kind === 'income' ? '+' : '−'}{ils(e.amount)}
                </span>
              </div>
              {showActions && canEdit && (
                <div className="mt-3 flex items-center justify-end">
                  <RowActions entry={e} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} size="lg" />
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm font-bold text-ink">
          <span className="flex items-baseline gap-1.5"><span className="text-xs font-medium text-ink-3">נכנס</span><span dir="ltr" className="font-num tabular-nums text-emerald-700">{ils(income)}</span></span>
          <span className="flex items-baseline gap-1.5"><span className="text-xs font-medium text-ink-3">יצא</span><span dir="ltr" className="font-num tabular-nums text-rose-700">{ils(expense)}</span></span>
        </div>
      </div>

      {/* Desktop: table */}
      <div className="hidden overflow-hidden rounded-xl border border-line bg-white roomy:block">
        <Table className={TABLE_CLASS}>
          <colgroup>
            <col style={{ width: COL_PX.date }} />
            <col />
            <col style={{ width: COL_PX.amount }} />
            <col style={{ width: COL_PX.amount }} />
            {showActions && <col style={{ width: COL_PX.actions }} />}
          </colgroup>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-line">
            <TableRow className="bg-surface-2 hover:bg-surface-2">
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>תאריך</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-start')}>מטרה / תיאור</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>הכנסה</TableHead>
              <TableHead className={cn(HEAD_CLASS, 'text-center')}>הוצאה</TableHead>
              {showActions && <TableHead className={cn(HEAD_CLASS, 'text-end')}>פעולות</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e, i) => (
              <TableRow key={e.id ?? i} className="h-[46px] border-b border-line-soft hover:bg-row-hover">
                <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm tabular-nums text-ink-2">{whenOf(e)}</TableCell>
                <TableCell className="truncate px-4 py-3 text-start text-sm" title={e.description ? `${e.category_name} — ${e.description}` : e.category_name}>
                  <span className="font-medium text-ink">{e.category_name}</span>
                  {e.description && <span className="text-ink-2"> — {e.description}</span>}
                  {showUnpublished && !e.published && <span className="ms-2 inline-block align-middle"><UnpublishedBadge /></span>}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm font-bold tabular-nums text-emerald-700">
                  {e.kind === 'income' ? ils(e.amount) : <span className="font-normal text-ink-ghost">—</span>}
                </TableCell>
                <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm font-bold tabular-nums text-rose-700">
                  {e.kind === 'expense' ? ils(e.amount) : <span className="font-normal text-ink-ghost">—</span>}
                </TableCell>
                {showActions && (
                  <TableCell className="px-4 py-3 text-end" onClick={(ev) => ev.stopPropagation()}>
                    <div className="flex justify-end">
                      <RowActions entry={e} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} size="sm" />
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            <TableRow className="border-t border-line bg-surface-2 hover:bg-surface-2">
              <TableCell colSpan={2} className="px-4 py-3 text-start text-sm font-bold text-ink">סה״כ</TableCell>
              <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm font-bold tabular-nums text-emerald-700">{ils(income)}</TableCell>
              <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm font-bold tabular-nums text-rose-700">{ils(expense)}</TableCell>
              {showActions && <TableCell />}
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </>
  );
}

'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ils } from '@/lib/finance/format';
import type { FinKind } from '@/lib/constants/finance';
import type { FinEntry } from '@/lib/types/finance';
import { EntryFilesPopover } from './EntryFilesPopover';

// One month's lines of one kind, grouped by category with a subtotal per
// category and a total at the bottom. Desktop: a table (DESIGN.md §9, token
// variant of DebtorsTable); phones: cards per line (`roomy:` variant).

interface Group {
  categoryId: string;
  name: string;
  hotWater: boolean;
  entries: FinEntry[];
  total: number;
}

function groupByCategory(entries: FinEntry[]): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    let g = map.get(e.category_id);
    if (!g) {
      g = { categoryId: e.category_id, name: e.category_name, hotWater: e.category_is_hot_water, entries: [], total: 0 };
      map.set(e.category_id, g);
    }
    g.entries.push(e);
    g.total += e.amount;
  }
  return [...map.values()];
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' without touching Date (no time zone games). */
function fmtDate(iso: string | null): string {
  return iso ? iso.split('-').reverse().join('/') : '—';
}

function HotWaterBadge() {
  return (
    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">מים חמים</span>
  );
}

function RowActions({ entry, canEdit, onEdit, onDelete, size }: {
  entry: FinEntry; canEdit: boolean; onEdit: (e: FinEntry) => void; onDelete: (e: FinEntry) => void; size: 'sm' | 'lg';
}) {
  if (!canEdit) return null;
  const btn = cn(
    'grid place-items-center rounded-lg transition-colors',
    size === 'lg' ? 'h-11 w-11' : 'h-9 w-9',
  );
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <button type="button" onClick={() => onEdit(entry)} aria-label="עריכה" className={cn(btn, 'text-slate-400 hover:bg-slate-100 hover:text-blue-600')}>
            <Pencil className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>עריכה</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<span className="block" />}>
          <button type="button" onClick={() => onDelete(entry)} aria-label="מחיקה" className={cn(btn, 'text-slate-400 hover:bg-red-50 hover:text-red-600')}>
            <Trash2 className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>מחיקה</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function EntryGroupTable({
  kind, entries, canEdit, onEdit, onDelete, emptyText,
}: {
  kind: FinKind;
  entries: FinEntry[];
  canEdit: boolean;
  onEdit: (e: FinEntry) => void;
  onDelete: (e: FinEntry) => void;
  emptyText: string;
}) {
  const groups = groupByCategory(entries);
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const isExpense = kind === 'expense';
  const amountTone = isExpense ? 'text-rose-700' : 'text-emerald-700';
  const colCount = isExpense ? 7 : 4;

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">{emptyText}</div>
    );
  }

  const head = 'h-11 px-4 text-sm font-semibold text-ink-2';
  return (
    <>
      {/* Phones: cards */}
      <div className="space-y-4 roomy:hidden">
        {groups.map((g) => (
          <div key={g.categoryId} className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="inline-flex items-center gap-2 text-sm font-bold text-ink">
                {g.name}
                {g.hotWater && <HotWaterBadge />}
              </span>
              <span dir="ltr" className={cn('font-num text-sm font-bold tabular-nums', amountTone)}>{ils(g.total)}</span>
            </div>
            <ul className="space-y-2">
              {g.entries.map((e) => (
                <li key={e.id} className="rounded-xl border border-line bg-white p-4 shadow-soft-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {isExpense ? (e.supplier_name || <span className="text-ink-ghost">ללא ספק</span>) : (e.description || <span className="text-ink-ghost">ללא תיאור</span>)}
                      </p>
                      <p className="mt-1 text-xs text-ink-3">
                        {isExpense ? (
                          <>
                            <span dir="ltr" className="font-num tabular-nums">{fmtDate(e.payment_date)}</span>
                            {e.invoice_number && <> · חשבונית <span dir="ltr" className="font-num tabular-nums">{e.invoice_number}</span></>}
                            {e.description && <> · {e.description}</>}
                          </>
                        ) : (
                          e.internal_note ? <>הערה: {e.internal_note}</> : null
                        )}
                      </p>
                    </div>
                    <span dir="ltr" className={cn('shrink-0 font-num text-base font-bold tabular-nums', amountTone)}>{ils(e.amount)}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <EntryFilesPopover documents={e.documents} size="lg" />
                    <RowActions entry={e} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} size="lg" />
                  </div>
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

      {/* Desktop: table */}
      <div className="hidden overflow-hidden rounded-xl border border-line bg-white roomy:block">
        <Table>
          <TableHeader className="[&_tr]:border-b [&_tr]:border-line">
            <TableRow className="bg-surface-2 hover:bg-surface-2">
              {isExpense ? (
                <>
                  <TableHead className={cn(head, 'text-center')}>תאריך</TableHead>
                  <TableHead className={cn(head, 'text-start')}>ספק</TableHead>
                  <TableHead className={cn(head, 'text-center')}>מס׳ חשבונית</TableHead>
                  <TableHead className={cn(head, 'text-start')}>תיאור</TableHead>
                </>
              ) : (
                <TableHead className={cn(head, 'text-start')}>תיאור</TableHead>
              )}
              <TableHead className={cn(head, 'text-center')}>סכום</TableHead>
              <TableHead className={cn(head, 'text-center')}>קבצים</TableHead>
              <TableHead className={cn(head, 'text-end')}>פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <GroupRows key={g.categoryId} group={g} isExpense={isExpense} colCount={colCount} amountTone={amountTone} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} />
            ))}
            <TableRow className="border-t border-line bg-surface-2 hover:bg-surface-2">
              <TableCell colSpan={colCount - 3} className="px-4 py-3 text-start text-sm font-bold text-ink">סה״כ</TableCell>
              <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(total)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function GroupRows({ group: g, isExpense, colCount, amountTone, canEdit, onEdit, onDelete }: {
  group: Group; isExpense: boolean; colCount: number; amountTone: string; canEdit: boolean;
  onEdit: (e: FinEntry) => void; onDelete: (e: FinEntry) => void;
}) {
  return (
    <>
      <TableRow className="border-b border-line-soft bg-slate-50/70 hover:bg-slate-50/70">
        <TableCell colSpan={colCount - 3} className="px-4 py-2 text-start text-sm font-bold text-ink">
          <span className="inline-flex items-center gap-2">
            {g.name}
            {g.hotWater && <HotWaterBadge />}
            <span className="text-xs font-medium text-ink-3">{g.entries.length} שורות</span>
          </span>
        </TableCell>
        <TableCell dir="ltr" className={cn('px-4 py-2 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(g.total)}</TableCell>
        <TableCell colSpan={2} />
      </TableRow>
      {g.entries.map((e) => (
        <TableRow key={e.id} className="h-[46px] border-b border-line-soft hover:bg-row-hover">
          {isExpense ? (
            <>
              <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm tabular-nums text-ink-2">{fmtDate(e.payment_date)}</TableCell>
              <TableCell className="px-4 py-3 text-start text-sm font-medium text-ink">
                {e.supplier_name || <span className="text-ink-ghost">—</span>}
              </TableCell>
              <TableCell dir="ltr" className="px-4 py-3 text-center font-num text-sm tabular-nums text-ink-2">
                {e.invoice_number || <span className="text-ink-ghost">—</span>}
              </TableCell>
              <TableCell className="max-w-[320px] truncate px-4 py-3 text-start text-sm text-ink-2" title={e.description}>
                {e.description || <span className="text-ink-ghost">—</span>}
              </TableCell>
            </>
          ) : (
            <TableCell className="max-w-[480px] truncate px-4 py-3 text-start text-sm font-medium text-ink" title={e.description}>
              {e.description || <span className="text-ink-ghost">—</span>}
            </TableCell>
          )}
          <TableCell dir="ltr" className={cn('px-4 py-3 text-center font-num text-sm font-bold tabular-nums', amountTone)}>{ils(e.amount)}</TableCell>
          <TableCell className="px-4 py-3 text-center" onClick={(ev) => ev.stopPropagation()}>
            <EntryFilesPopover documents={e.documents} />
          </TableCell>
          <TableCell className="px-4 py-3 text-end" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex justify-end">
              <RowActions entry={e} canEdit={canEdit} onEdit={onEdit} onDelete={onDelete} size="sm" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

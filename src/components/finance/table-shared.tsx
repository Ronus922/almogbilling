'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FinEntry } from '@/lib/types/finance';

// What every table of the finance module shares (DESIGN.md §35): the fixed
// column widths, the table class, the header cell class, the date format and
// the per-row edit / delete buttons — so the income table, the expense table
// and the fund ledger keep their numeric and action columns on one vertical
// line and look like one family.

/** Column widths (px). `table-fixed` + `<colgroup>` make them hold regardless
 *  of content; the text columns share what is left. */
export const COL_PX = {
  amount: 160,
  files: 128,
  actions: 112,
  date: 112,
  invoice: 144,
} as const;

/** Same `w-full` in the same parent, and the same minimum below which the
 *  `Table` wrapper scrolls horizontally instead of crushing the text columns. */
export const TABLE_CLASS = 'table-fixed min-w-[960px]';

export const HEAD_CLASS = 'h-11 px-4 text-sm font-semibold text-ink-2';

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' without touching Date (no time zone games). */
export function fmtDate(iso: string | null): string {
  return iso ? iso.split('-').reverse().join('/') : '—';
}

export function RowActions({ entry, canEdit, onEdit, onDelete, size }: {
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

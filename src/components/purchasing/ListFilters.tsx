'use client';

// The filter row between the tabs and the table, the same in both tabs: a wide search (supplier,
// subject or number — DESIGN §6 "Clearable search input") and a document-date range. The range is one
// button that reads "מתאריך — עד תאריך" and opens a small popover with two date inputs (DESIGN §6
// "Date Input": a click anywhere on the field opens the picker).

import { useState } from 'react';
import { Calendar, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDocDate } from '@/lib/purchasing/model';
import { cn } from '@/lib/utils';
import { EMPTY_FILTER, type ListFilter } from './listView';

interface Props {
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
}

const openPicker = (e: React.MouseEvent<HTMLInputElement>) => {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* the native icon still opens it */ }
};

function rangeLabel(from: string, to: string): string {
  return `${from ? formatDocDate(from) : 'מתאריך'} — ${to ? formatDocDate(to) : 'עד תאריך'}`;
}

function DateField({ id, label, value, min, max, onChange }: {
  id: string; label: string; value: string; min?: string; max?: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-muted-foreground">{label}</Label>
      <Input
        id={id} type="date" value={value} min={min} max={max}
        onChange={(e) => onChange(e.target.value)} onClick={openPicker}
        className="h-10 cursor-pointer"
      />
    </div>
  );
}

export function ListFilters({ filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ranged = filter.from !== '' || filter.to !== '';

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center" data-list-filters>
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <Input
          type="search" value={filter.q} data-filter-search
          onChange={(e) => onChange({ ...filter, q: e.target.value })}
          placeholder="חיפוש לפי ספק, נושא או מספר בקשה..."
          aria-label="חיפוש לפי ספק, נושא או מספר"
          className={cn('h-11 rounded-xl border-line bg-white ps-9 [&::-webkit-search-cancel-button]:hidden', filter.q && 'pe-9')}
        />
        {filter.q && (
          <button
            type="button" aria-label="נקה חיפוש" onClick={() => onChange({ ...filter, q: '' })}
            className="absolute end-0 top-0 grid h-11 w-11 place-items-center text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-filter-range data-ranged={ranged ? '' : undefined}
          aria-label="סינון לפי טווח תאריכים"
          className={cn(
            'inline-flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 text-sm font-medium transition-colors hover:bg-row-hover md:w-64',
            ranged ? 'text-ink' : 'text-ink-2',
          )}
        >
          <span className="tabular-nums">{rangeLabel(filter.from, filter.to)}</span>
          <Calendar aria-hidden className="h-4 w-4 shrink-0 text-ink-3" />
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-3 p-4" data-filter-range-panel>
          <DateField
            id="purchasing-from" label="מתאריך" value={filter.from} max={filter.to || undefined}
            onChange={(from) => onChange({ ...filter, from })}
          />
          <DateField
            id="purchasing-to" label="עד תאריך" value={filter.to} min={filter.from || undefined}
            onChange={(to) => onChange({ ...filter, to })}
          />
          {ranged && (
            <button
              type="button" data-filter-range-clear
              onClick={() => onChange({ ...filter, from: EMPTY_FILTER.from, to: EMPTY_FILTER.to })}
              className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-ink-2 hover:bg-row-hover hover:text-ink"
            >
              נקה טווח
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

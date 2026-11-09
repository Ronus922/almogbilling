'use client';

import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// The filter row above the table: one search (a first or last name, either
// order, or part of a phone number) and an inclusive scan-day range. Per DESIGN
// §6 the range is two native date inputs — the datePicker exception is declared
// for the purchasing lists only — which on an iPhone are the system's own wheel.

export interface VisitorFilter {
  q: string;
  from: string;
  to: string;
}

export const EMPTY_VISITOR_FILTER: VisitorFilter = { q: '', from: '', to: '' };

interface Props {
  filter: VisitorFilter;
  onChange: (next: VisitorFilter) => void;
}

const dateClass = 'h-11 w-full cursor-pointer rounded-xl border-line bg-white';

function showPicker(e: React.MouseEvent<HTMLInputElement>): void {
  const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void };
  try { el.showPicker?.(); } catch { /* the native icon still works */ }
}

export function VisitorFilters({ filter, onChange }: Props) {
  const active = filter.q !== '' || filter.from !== '' || filter.to !== '';
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end" data-visitor-filters>
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
        <Input
          type="search" value={filter.q} data-filter-search enterKeyHint="search"
          onChange={(e) => onChange({ ...filter, q: e.target.value })}
          placeholder="חיפוש לפי שם או טלפון..." aria-label="חיפוש לפי שם או טלפון"
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

      <div className="grid grid-cols-2 gap-3 md:flex md:items-end">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-semibold text-slate-500">מתאריך</span>
          <Input type="date" value={filter.from} max={filter.to || undefined} dir="ltr" data-filter-from
            onChange={(e) => onChange({ ...filter, from: e.target.value })} onClick={showPicker}
            className={cn(dateClass, 'md:w-44')} aria-label="מתאריך" />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-semibold text-slate-500">עד תאריך</span>
          <Input type="date" value={filter.to} min={filter.from || undefined} dir="ltr" data-filter-to
            onChange={(e) => onChange({ ...filter, to: e.target.value })} onClick={showPicker}
            className={cn(dateClass, 'md:w-44')} aria-label="עד תאריך" />
        </label>
      </div>

      {active && (
        <Button type="button" variant="outline" onClick={() => onChange(EMPTY_VISITOR_FILTER)}
          className="h-11 rounded-xl" data-filter-clear>
          <X className="h-4 w-4" aria-hidden />
          נקה סינון
        </Button>
      )}
    </div>
  );
}

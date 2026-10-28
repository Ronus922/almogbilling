'use client';

// The filter row between the tabs and the table, the same in both tabs: a wide search (supplier,
// subject or number — DESIGN §6 "Clearable search input") and a document-date range. The range is one
// button that reads "מתאריך — עד תאריך" and opens the datePicker skill's DateRangePicker (DESIGN §6
// "Date Input", the declared exception for this screen). The picker has no half-open range, so the filter
// is a whole range or nothing, and it changes only on the picker's "סגור": Esc, X, a click outside or the
// trigger again leave the filter as it was, so a half-picked range never filters the table. The clear
// button sits beside the trigger because the picker has no room for one.
//
// On a phone the picker is the component's documented layout="stacked" (a popover with the two months one
// above the other and the previous/next arrows), not its default Bottom Sheet: the sheet lists the months
// from the current one forward only, so it could never reach a document dated before this month. The phone
// is decided by the component's own breakpoint (MOBILE_QUERY), so the two never disagree.

import { useMemo, useRef, useState } from 'react';
import { Calendar, Search, X } from 'lucide-react';
import { DateRangePicker, type DateRange } from '@/components/date-range-picker';
import { MOBILE_QUERY } from '@/components/date-range-picker/DateRangePicker';
import { useMediaQuery } from '@/components/date-range-picker/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDocDate } from '@/lib/purchasing/model';
import { cn } from '@/lib/utils';
import { EMPTY_FILTER, type ListFilter } from './listView';

interface Props {
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
}

const NO_RANGE: DateRange = { start: null, end: null };

// The picker's own footer line is written for a booking form ("…לשמירה לחצו שמור שינויים"); this is a list
// filter, and the button that applies it is "סגור". Phone only, so the desktop picker stays as it shipped.
const PHONE_HINT = { done: 'לחצו סגור כדי לסנן את הרשימה', pending: 'לחצו על תאריך היציאה כדי לסיים את הבחירה' };

function rangeLabel(from: string, to: string): string {
  return `${from ? formatDocDate(from) : 'מתאריך'} — ${to ? formatDocDate(to) : 'עד תאריך'}`;
}

export function ListFilters({ filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  // While the picker is open it edits a draft; the filter itself moves only on "סגור".
  const [draft, setDraft] = useState<DateRange>(NO_RANGE);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const phone = useMediaQuery(MOBILE_QUERY);
  const ranged = filter.from !== '' || filter.to !== '';
  const applied = useMemo<DateRange>(
    () => ({ start: filter.from || null, end: filter.to || null }),
    [filter.from, filter.to],
  );

  const toggle = () => {
    if (!open) setDraft(applied);
    setOpen(!open);
  };

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

      <div className="flex items-center gap-2">
        <button
          ref={triggerRef} type="button" onClick={toggle}
          data-filter-range data-ranged={ranged ? '' : undefined}
          aria-label="סינון לפי טווח תאריכים" aria-haspopup="dialog" aria-expanded={open}
          className={cn(
            'inline-flex h-11 min-w-0 flex-1 items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 text-sm font-medium transition-colors hover:bg-row-hover md:w-64 md:flex-none',
            ranged ? 'text-ink' : 'text-ink-2',
          )}
        >
          <span className="tabular-nums">{rangeLabel(filter.from, filter.to)}</span>
          <Calendar aria-hidden className="h-4 w-4 shrink-0 text-ink-3" />
        </button>
        {ranged && (
          <Button
            type="button" variant="outline" size="icon" data-filter-range-clear
            onClick={() => onChange({ ...filter, from: EMPTY_FILTER.from, to: EMPTY_FILTER.to })}
            aria-label="נקה טווח תאריכים" title="נקה טווח"
            className="h-11 w-11 shrink-0 rounded-xl"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>

      <DateRangePicker
        value={open ? draft : applied}
        onChange={setDraft}
        open={open} anchorRef={triggerRef} hideTrigger className="app-drp" layout={phone ? 'stacked' : 'auto'}
        footerHint={phone ? PHONE_HINT : undefined}
        onCommit={(r) => {
          onChange({ ...filter, from: r.start ?? '', to: r.end ?? '' });
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
